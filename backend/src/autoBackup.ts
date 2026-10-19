import { mkdir, writeFile, readdir, readFile, stat } from 'node:fs/promises'
import { unlinkSync } from 'node:fs'
import path from 'node:path'
import { desc, eq, gte, isNotNull, lte, ne, sql, and } from 'drizzle-orm'
import { exportScopeData, backupDirectory } from './routes/backup'
import { logger } from './logger'
import { notifyBackupComplete, notifyLowStock, notifyDailySummary } from './notifications'
import { loadNotificationPrefs, resolveOwnerRecipient } from './notificationPrefs'
import { db, getRawClient } from './db/client'
import * as schema from './db/schema'
import { escapeHtml } from './htmlEscape'
import { createScheduler } from './lib/scheduler'

export const AUTO_BACKUP_HOUR = 19
export const AUTO_BACKUP_MINUTE = 0
export const DAILY_SUMMARY_HOUR = 9
export const DAILY_SUMMARY_MINUTE = 0

export function autoBackupDirectory(): string {
  return backupDirectory()
}

const IST_TIMEZONE = 'Asia/Kolkata'

function istFileStamp(date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: IST_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date)
  const get = (t: string) => parts.find((x) => x.type === t)?.value ?? '00'
  return `${get('year')}-${get('month')}-${get('day')}-${get('hour')}-${get('minute')}-${get('second')}`
}

function msUntilNextRun(now = new Date()): number {
  const next = new Date(now)
  next.setHours(AUTO_BACKUP_HOUR, AUTO_BACKUP_MINUTE, 0, 0)
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1)
  return next.getTime() - now.getTime()
}

// ─── Encrypted auto-backup toggle (stored in settings jsonb) ─────────────────
export async function isAutoBackupEncrypted(): Promise<boolean> {
  if (!db) return false
  try {
    const [row] = await db.select({ notificationSettings: schema.settings.notificationSettings }).from(schema.settings).where(eq(schema.settings.id, 'app')).limit(1)
    return (row?.notificationSettings as Record<string, unknown> | null)?.autoBackupEncrypted === true
  } catch {
    return false
  }
}

export async function setAutoBackupEncrypted(value: boolean): Promise<void> {
  if (!db) return
  const [row] = await db.select({ notificationSettings: schema.settings.notificationSettings }).from(schema.settings).where(eq(schema.settings.id, 'app')).limit(1)
  const current = (row?.notificationSettings ?? {}) as Record<string, unknown>
  await db.update(schema.settings).set({ notificationSettings: { ...current, autoBackupEncrypted: value } }).where(eq(schema.settings.id, 'app'))
}

/** When true, the 7 PM auto-backup also emails the fresh archive (≤20 MB). */
export async function isBackupEmailEnabled(): Promise<boolean> {
  if (!db) return false
  try {
    const [row] = await db.select({ notificationSettings: schema.settings.notificationSettings }).from(schema.settings).where(eq(schema.settings.id, 'app')).limit(1)
    return (row?.notificationSettings as Record<string, unknown> | null)?.autoBackupEmail === true
  } catch {
    return false
  }
}

export async function setBackupEmailEnabled(value: boolean): Promise<void> {
  if (!db) return
  const [row] = await db.select({ notificationSettings: schema.settings.notificationSettings }).from(schema.settings).where(eq(schema.settings.id, 'app')).limit(1)
  const current = (row?.notificationSettings ?? {}) as Record<string, unknown>
  await db.update(schema.settings).set({ notificationSettings: { ...current, autoBackupEmail: value } }).where(eq(schema.settings.id, 'app'))
}

async function runAutoBackup(): Promise<void> {
  const result = await exportScopeData('full')
  if (!result.ok) {
    logger.error({ err: result.error }, 'Auto backup export failed')
    return
  }
  const dir = autoBackupDirectory()
  try {
    await mkdir(dir, { recursive: true })
    const stamp = istFileStamp()
    const encrypted = await isAutoBackupEncrypted()
    const fileName = encrypted ? `auto-backup-full-${stamp}.enc.json` : `auto-backup-full-${stamp}.json`
    const payload = {
      _backup: { type: 'full', label: 'Full Backup (auto)', exportedAt: new Date().toISOString(), encrypted },
      data: result.data,
    }
    if (encrypted) {
      // AES-256-GCM encrypt the payload so files at rest (and off-site) are opaque
      const { encryptBackupFile } = await import('./routes/backup')
      await writeFile(path.join(dir, fileName), JSON.stringify({ _encrypted: true, payload: encryptBackupFile(JSON.stringify(payload)) }), 'utf8')
    } else {
      await writeFile(path.join(dir, fileName), JSON.stringify(payload, null, 2), 'utf8')
    }
    logger.info({ file: fileName, tables: Object.keys(result.data).length, encrypted }, 'Auto backup completed')
    await pruneOldBackups()

    // Off-site push (no-op when BACKUP_OFFSITE_* env vars are absent)
    try {
      const { pushLatestBackupOffsite } = await import('./offsiteBackup')
      await pushLatestBackupOffsite(fileName)
    } catch (err) { logger.debug({ err }, 'Off-site push hook skipped') }

    // Send email notification if configured
    try {
      const email = process.env.NOTIFICATION_EMAIL?.trim()
      if (email) {
        await notifyBackupComplete(email, {
          type: 'Full Backup',
          tables: Object.keys(result.data).length,
          fileName,
        })
        logger.info({ email }, 'Backup notification sent')
      }
    } catch (err) { logger.error({ err }, 'Backup notification failed') }

    // Optionally attach the fresh archive to an email (auto-send toggle).
    try {
      if (await isBackupEmailEnabled()) {
        const { notifyBackupFiles } = await import('./notifications')
        const recipient = process.env.NOTIFICATION_EMAIL?.trim()
        if (recipient) {
          const content = await readFile(path.join(autoBackupDirectory(), fileName))
          // 20 MB attachment guard — oversize archives are skipped with a log
          // instead of a failed 25+ MB SMTP send.
          const { filterAttachableFiles } = await import('./mailAttachments')
          const budget = filterAttachableFiles([{ fileName, content }])
          if (budget.attachable.length === 0) {
            logger.warn({ file: fileName, sizeMb: (content.length / (1024 * 1024)).toFixed(1) }, 'Auto-backup archive too large to email — skipped')
            return
          }
          const sent = await notifyBackupFiles(recipient, [{ fileName, content }], {
            scopeLabel: 'Full Backup (auto email)',
            tableCount: Object.keys(result.data).length,
            recordCount: Object.values(result.data).reduce((a: number, t) => a + (Array.isArray(t) ? t.length : 0), 0),
            note: 'Attached automatically after the 7:00 PM IST auto-backup.',
          })
          logger.info({ sent, file: fileName }, 'Auto-backup email attempt finished')
        }
      }
    } catch (err) { logger.warn({ err }, 'Auto-backup email attach skipped') }

    // Check low stock and send alert
    try {
      const email = process.env.NOTIFICATION_EMAIL?.trim()
      if (email && result.data.products) {
        const lowStock = (result.data.products as any[]).filter(
          (p) => p.track_inventory !== false && p.stock != null && p.reorder_level != null && Number(p.stock) <= Number(p.reorder_level)
        )
        if (lowStock.length > 0) {
          await notifyLowStock(email, lowStock.map((p) => ({
            name: p.name, sku: p.sku, stock: Number(p.stock), reorderLevel: Number(p.reorder_level)
          })))
          logger.info({ count: lowStock.length }, 'Low stock notification sent')
        }
      }
    } catch (err) { logger.error({ err }, 'Low stock notification failed') }
  } catch (err) {
    logger.error({ err }, 'Auto backup file write failed')
  }
}

const scheduler = createScheduler({
  label: 'Auto backup',
  msUntilNextRun,
  run: () => runAutoBackup(),
})

// ─── Daily summary email ────────────────────────────────────────────

let summaryTimer: NodeJS.Timeout | null = null

function msUntilNextSummary(now = new Date()): number {
  const next = new Date(now)
  next.setHours(DAILY_SUMMARY_HOUR, DAILY_SUMMARY_MINUTE, 0, 0)
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1)
  return next.getTime() - now.getTime()
}

export async function runDailySummary(): Promise<void> {
  try {
    if (!db) return
    const [settingsRow] = await db.select().from(schema.settings).where(eq(schema.settings.id, 'app')).limit(1)
    // Both switches control this email: the Notification Settings toggle and
    // the legacy Business Settings toggle (kept in sync on write; either can disable).
    const prefs = await loadNotificationPrefs()
    if (!prefs.dailySummaryEnabled || (settingsRow && settingsRow.dailySummary === false)) {
      logger.info('Daily summary email skipped — disabled in notification settings')
      return
    }
    const recipient = resolveOwnerRecipient(prefs, settingsRow?.email)
    if (!recipient) {
      logger.debug('Daily summary skipped — no recipient address configured')
      return
    }
    const sent = await sendDailySummaryEmail(recipient)
    if (sent) logger.info({ recipient }, 'Daily summary email sent')
  } catch (err) {
    logger.error({ err }, 'Daily summary failed')
  }
}

/**
 * Gather the full daily picture — sales, orders, new customers, silver rate,
 * most-sold product (30d), top 5 products, low-stock detail, dues PDF — and
 * email the rich summary. Shared by the 9 AM scheduler and the manual
 * "Send now" action on the Notifications page.
 */
export async function sendDailySummaryEmail(recipient: string): Promise<boolean> {
  if (!db) return false
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  const dayAgo2 = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()

  const [salesRow] = await db
    .select({ total: sql<number>`coalesce(sum(${schema.salesInvoices.grandTotal}), 0)::float` })
    .from(schema.salesInvoices)
    .where(gte(schema.salesInvoices.date, since24h))
  const [yesterdayRow] = await db
    .select({ total: sql<number>`coalesce(sum(${schema.salesInvoices.grandTotal}), 0)::float` })
    .from(schema.salesInvoices)
    .where(and(gte(schema.salesInvoices.date, dayAgo2), sql`${schema.salesInvoices.date} < ${since24h}`))
  const [ordersRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.salesOrders)
    .where(gte(schema.salesOrders.date, since24h))
  const [pendingRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.salesInvoices)
    .where(ne(schema.salesInvoices.paymentStatus, 'paid'))
  const [newCustRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.customers)
    .where(gte(schema.customers.joined, new Date().toISOString().slice(0, 10)))
  const [lowStockRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.products)
    .where(and(isNotNull(schema.products.stock), isNotNull(schema.products.reorderLevel), lte(schema.products.stock, schema.products.reorderLevel)))

  // Most-sold + top 5 products over the last 30 days from invoice line items.
  let topProducts: Array<{ name: string; sku: string; qty: number; revenue: number; orders?: number }> = []
  try {
    const itemRows = await db
      .select({
        sku: schema.salesInvoiceItems.sku,
        product: schema.salesInvoiceItems.product,
        qty: schema.salesInvoiceItems.qty,
        amount: schema.salesInvoiceItems.amount,
        invoiceId: schema.salesInvoiceItems.invoiceId,
      })
      .from(schema.salesInvoiceItems)
      .innerJoin(schema.salesInvoices, eq(schema.salesInvoiceItems.invoiceId, schema.salesInvoices.id))
      .where(gte(schema.salesInvoices.date, since30d))
    const agg = new Map<string, { name: string; sku: string; qty: number; revenue: number; orders: Set<string> }>()
    for (const it of itemRows) {
      const key = String(it.sku ?? it.product ?? '')
      if (!key) continue
      const entry = agg.get(key) ?? { name: String(it.product ?? key), sku: key, qty: 0, revenue: 0, orders: new Set<string>() }
      entry.qty += Number(it.qty) || 0
      entry.revenue += Number(it.amount) || 0
      if (it.invoiceId) entry.orders.add(it.invoiceId)
      agg.set(key, entry)
    }
    topProducts = [...agg.values()]
      .sort((a, b) => b.qty - a.qty)
      .slice(0, 5)
      .map((e) => ({ name: e.name, sku: e.sku, qty: e.qty, revenue: Math.round(e.revenue * 100) / 100, orders: e.orders.size }))
  } catch (err) {
    logger.warn({ err }, 'Daily summary: product ranking skipped')
  }

  // Low-stock detail rows with 30-day sales velocity for prioritisation.
  let lowStockItems: Array<{ name: string; sku: string; stock: number; reorderLevel: number; qtySold30d?: number }> = []
  try {
    const client = getRawClient()
    if (client) {
      const rows = await client.unsafe(
        `SELECT p.name, p.sku, p.stock, p.reorder_level,
           COALESCE((SELECT SUM(ii.qty) FROM sales_invoice_items ii
             JOIN sales_invoices si ON si.id = ii.invoice_id
             WHERE ii.sku = p.sku AND si.date >= $1), 0) AS qty_sold_30d
         FROM products p
         WHERE p.track_inventory != false AND p.stock IS NOT NULL AND p.reorder_level IS NOT NULL AND p.stock <= p.reorder_level
         ORDER BY p.stock ASC, qty_sold_30d DESC
         LIMIT 25`,
        [since30d],
      )
      lowStockItems = rows.map((r: any) => ({
        name: String(r.name ?? ''),
        sku: String(r.sku ?? ''),
        stock: Number(r.stock ?? 0),
        reorderLevel: Number(r.reorder_level ?? 0),
        qtySold30d: Number(r.qty_sold_30d ?? 0),
      }))
    }
  } catch (err) {
    logger.warn({ err }, 'Daily summary: low stock detail skipped')
  }

  // Latest silver rate for the header block.
  let silverRate: { rate: number; change: number; updatedAt: string | null } | null = null
  try {
    const [latest] = await db.select().from(schema.silverRates).orderBy(desc(schema.silverRates.updatedAt)).limit(1)
    if (latest) silverRate = { rate: Number(latest.rate), change: Number(latest.change ?? 0), updatedAt: latest.updatedAt ?? null }
  } catch (err) {
    logger.warn({ err }, 'Daily summary: silver rate skipped')
  }

  // Dues statement: collect outstanding invoices and attach a PDF when any exist
  let attachment: { filename: string; content: Buffer } | undefined
  let duesTotal: number | undefined
  let duesCustomers: number | undefined
  try {
    const { generateDuesStatementPDF } = await import('./statements')
    const statement = await generateDuesStatementPDF()
    if (statement) {
      attachment = { filename: `dues-statement-${new Date().toISOString().slice(0, 10)}.pdf`, content: statement.buffer }
      duesTotal = statement.totalDue
      duesCustomers = statement.customerCount
    }
  } catch (err) {
    logger.warn({ err }, 'Dues statement attachment skipped')
  }

  return notifyDailySummary(recipient, {
    todaySales: Number(salesRow?.total ?? 0),
    todayOrders: Number(ordersRow?.count ?? 0),
    pendingPayments: Number(pendingRow?.count ?? 0),
    lowStockCount: Number(lowStockRow?.count ?? 0),
    yesterdaySales: Number(yesterdayRow?.total ?? 0),
    newCustomers: Number(newCustRow?.count ?? 0),
    lowStockItems,
    topProducts,
    mostSoldProduct: topProducts[0] ?? null,
    silverRate,
    duesTotal,
    duesCustomers,
    attachment,
  })
}

function scheduleSummary(): void {
  summaryTimer = setTimeout(() => {
    scheduleSummary()
    void runDailySummary()
  }, msUntilNextSummary())
  summaryTimer.unref()
}

export function startDailySummary(): void {
  if (summaryTimer) return
  scheduleSummary()
  logger.info({ next: new Date(Date.now() + msUntilNextSummary()).toISOString() }, 'Daily summary scheduler started (9:00 AM IST)')
}

export function stopDailySummary(): void {
  if (summaryTimer) clearTimeout(summaryTimer)
  summaryTimer = null
}

const KEEP_BACKUPS = 15
const PRE_RESTORE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

async function pruneOldBackups(): Promise<void> {
  try {
    const dir = backupDirectory()
    await mkdir(dir, { recursive: true })
    const names = (await readdir(dir)).filter(n => n.endsWith('.json'))
    const files: Array<{ name: string; exportedAt: string | null; isPreRestore: boolean }> = []
    for (const name of names) {
      try {
        const raw = await readFile(path.join(dir, name), 'utf8')
        const parsed = JSON.parse(raw)
        const meta = parsed._backup as { exportedAt?: string; isPreRestore?: boolean } | undefined
        files.push({ name, exportedAt: meta?.exportedAt ?? null, isPreRestore: meta?.isPreRestore === true })
      } catch {
        files.push({ name, exportedAt: null, isPreRestore: false })
      }
    }

    const deletable = files.filter(f => !f.isPreRestore).sort((a, b) => (b.exportedAt ?? '').localeCompare(a.exportedAt ?? ''))
    const toDelete = deletable.slice(KEEP_BACKUPS)

    const cutoff = new Date(Date.now() - PRE_RESTORE_MAX_AGE_MS).toISOString()
    const oldPreRestore = files.filter(f => f.isPreRestore && f.exportedAt && f.exportedAt < cutoff)

    const deleted: string[] = []
    for (const f of [...toDelete, ...oldPreRestore]) {
      try {
        unlinkSync(path.join(dir, f.name))
        deleted.push(f.name)
      } catch { /* skip */ }
    }
    if (deleted.length > 0) {
      logger.info({ deleted: deleted.length, kept: files.length - deleted.length }, 'Auto-pruned old backups')
    }
  } catch (err) {
    logger.error({ err }, 'Backup auto-prune failed')
  }
}

export function startAutoBackup(): void {
  if (scheduler.armed) return
  scheduler.schedule()
  logger.info({ next: istFileStamp(new Date(Date.now() + msUntilNextRun())), timezone: IST_TIMEZONE, keepLast: KEEP_BACKUPS }, 'Auto backup scheduled (daily 7:00 PM)')
}

/** Status for the Backup page card: last auto backup file + next scheduled run. */
export async function getAutoBackupStatus(): Promise<{
  enabled: boolean
  scheduleLabel: string
  nextRunAt: string
  lastBackup: { fileName: string; exportedAt: string | null; sizeBytes: number } | null
  backupCount: number
}> {
  const nextRun = new Date()
  nextRun.setHours(AUTO_BACKUP_HOUR, AUTO_BACKUP_MINUTE, 0, 0)
  if (nextRun.getTime() <= Date.now()) nextRun.setDate(nextRun.getDate() + 1)

  let lastBackup: { fileName: string; exportedAt: string | null; sizeBytes: number } | null = null
  let backupCount = 0
  try {
    const dir = autoBackupDirectory()
    const names = (await readdir(dir)).filter((n) => n.endsWith('.json'))
    backupCount = names.length
    const files: Array<{ fileName: string; exportedAt: string | null; sizeBytes: number }> = []
    for (const name of names) {
      try {
        const st = await stat(path.join(dir, name))
        let exportedAt: string | null = null
        try {
          const parsed = JSON.parse(await readFile(path.join(dir, name), 'utf8'))
          const meta = parsed._backup as { exportedAt?: string } | undefined
          exportedAt = meta?.exportedAt ?? null
        } catch {
          exportedAt = null
        }
        files.push({ fileName: name, exportedAt: exportedAt ?? st.mtime.toISOString(), sizeBytes: st.size })
      } catch { /* skip unreadable files */ }
    }
    files.sort((a, b) => (b.exportedAt ?? '').localeCompare(a.exportedAt ?? ''))
    lastBackup = files[0] ?? null
  } catch { /* directory missing → no backups yet */ }

  return {
    enabled: scheduler.armed,
    scheduleLabel: `Daily at ${String(AUTO_BACKUP_HOUR).padStart(2, '0')}:${String(AUTO_BACKUP_MINUTE).padStart(2, '0')} IST`,
    nextRunAt: nextRun.toISOString(),
    lastBackup,
    backupCount,
  }
}

export function stopAutoBackup(): void {
  scheduler.stop()
}

// ─── Backup integrity verification (weekly) ──────────────────────────────────
// Reads every stored backup (decrypting encrypted ones), validates JSON and
// the _backup marker, and emails a summary if any file is corrupt.

export interface BackupIntegrityResult {
  checked: number
  ok: number
  corrupt: Array<{ fileName: string; error: string }>
  verifiedAt: string
}

export async function verifyAllBackups(): Promise<BackupIntegrityResult> {
  const result: BackupIntegrityResult = { checked: 0, ok: 0, corrupt: [], verifiedAt: new Date().toISOString() }
  const dir = autoBackupDirectory()
  let names: string[] = []
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith('.json'))
  } catch {
    return result
  }
  for (const name of names) {
    result.checked++
    try {
      const raw = await readFile(path.join(dir, name), 'utf8')
      const parsed = JSON.parse(raw) as Record<string, unknown>
      let data: unknown = parsed
      if (parsed && typeof parsed === 'object' && parsed._encrypted === true && typeof parsed.payload === 'string') {
        const { decryptBackupFile } = await import('./routes/backup')
        data = JSON.parse(decryptBackupFile(parsed.payload as string))
      }
      const meta = (data as Record<string, unknown>)._backup as { type?: string; exportedAt?: string } | undefined
      const tables = (data as Record<string, unknown>).data as Record<string, unknown> | undefined
      if (!meta?.type) throw new Error('missing _backup metadata')
      if (!tables || typeof tables !== 'object' || Object.keys(tables).length === 0) throw new Error('no table data')
      result.ok++
    } catch (err) {
      result.corrupt.push({ fileName: name, error: err instanceof Error ? err.message : 'Unreadable' })
    }
  }
  if (result.corrupt.length > 0) {
    logger.warn({ corrupt: result.corrupt.length }, 'Backup integrity check found corrupt files')
  } else {
    logger.info({ checked: result.checked }, 'Backup integrity check passed')
  }
  return result
}

let verifyTimer: NodeJS.Timeout | null = null

async function runWeeklyVerification(): Promise<void> {
  const res = await verifyAllBackups()
  if (res.corrupt.length === 0) return
  try {
    const email = process.env.NOTIFICATION_EMAIL?.trim()
    if (!email) return
    const { sendEmail } = await import('./notifications')
    await sendEmail({
      to: email,
      subject: `⚠️ ${res.corrupt.length} corrupt backup file(s) detected`,
      html: `<p>Weekly backup integrity check found <strong>${res.corrupt.length}</strong> of ${res.checked} backup files unreadable:</p><ul>${res.corrupt.map((c) => `<li><code>${escapeHtml(c.fileName)}</code> — ${escapeHtml(c.error)}</li>`).join('')}</ul><p>These files cannot be restored from. Take a fresh backup and review storage health.</p>`,
    })
    logger.info('Corrupt-backup alert emailed')
  } catch (err) {
    logger.warn({ err }, 'Corrupt-backup alert failed')
  }
}

/** Weekly (Monday 8:30 AM IST) integrity verification with email alert on corruption. */
export function startBackupVerification(): void {
  if (verifyTimer) return
  const msUntilMonday = (): number => {
    const now = new Date()
    const next = new Date(now)
    next.setHours(8, 30, 0, 0)
    const daysAhead = (1 - next.getDay() + 7) % 7 || (next.getTime() <= now.getTime() ? 7 : 0)
    next.setDate(next.getDate() + daysAhead)
    return next.getTime() - now.getTime()
  }
  verifyTimer = setTimeout(() => {
    startBackupVerification() // reschedule first
    void runWeeklyVerification()
  }, msUntilMonday())
  verifyTimer.unref()
  logger.info({ nextCheckMs: msUntilMonday() }, 'Weekly backup verification scheduled (Mon 8:30 AM IST)')
}

export function stopBackupVerification(): void {
  if (verifyTimer) clearTimeout(verifyTimer)
  verifyTimer = null
}
