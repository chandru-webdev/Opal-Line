import { eq } from 'drizzle-orm'
import { db } from './db/client'
import * as schema from './db/schema'
import { logger } from './logger'
import { recordActivity } from './activity'
import { collectSupplierDues } from './purchases'
import { sendEmail } from './notifications'
import { loadNotificationPrefs, resolveOwnerRecipient } from './notificationPrefs'
import { escapeHtml } from './htmlEscape'
import { createScheduler } from './lib/scheduler'

/**
 * Supplier payables sweep — a daily "here's who you owe" email.
 *
 * Customer dues already have a scheduled reminder; supplier dues only ever got
 * emailed when someone remembered to click Send Summary, which meant overdue
 * supplier balances could sit unnoticed for weeks. This runs shortly after the
 * sales follow-up sweep and sends one summary, not one email per supplier.
 *
 * It is deliberately quiet when there is nothing owed, and never sends more
 * than one email a day no matter how often the timer restarts.
 */

const HOUR = 9
const MINUTE = 20

let lastRunKey = ''

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function inr(n: number): string {
  return `₹${round2(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function msUntilNextRun(now = new Date()): number {
  const next = new Date(now)
  next.setHours(HOUR, MINUTE, 0, 0)
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1)
  return next.getTime() - now.getTime()
}

function dayKey(d = new Date()): string {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

async function recipient(): Promise<string> {
  const prefs = await loadNotificationPrefs()
  if (!db) return prefs.recipientEmail
  const [row] = await db
    .select({ email: schema.settings.email })
    .from(schema.settings)
    .where(eq(schema.settings.id, 'app'))
    .limit(1)
  return resolveOwnerRecipient(prefs, row?.email)
}

/**
 * Run the sweep. Returns what happened so it can be tested and logged.
 * `force` bypasses the once-a-day guard (used by the manual endpoint).
 */
export async function runSupplierPayables(opts: { force?: boolean } = {}): Promise<{
  sent: boolean
  suppliers: number
  total: number
  overdue: number
  reason?: string
}> {
  const today = dayKey()
  if (!opts.force && lastRunKey === today) {
    return { sent: false, suppliers: 0, total: 0, overdue: 0, reason: 'Already sent today' }
  }

  const dues = await collectSupplierDues()
  if (dues.length === 0) {
    lastRunKey = today
    logger.info('Supplier payables sweep: nothing outstanding')
    return { sent: false, suppliers: 0, total: 0, overdue: 0, reason: 'No supplier dues outstanding' }
  }

  const total = round2(dues.reduce((a, d) => a + d.balance, 0))
  const overdue = round2(dues.reduce((a, d) => a + d.d1_30 + d.d31_60 + d.d60plus, 0))
  const to = await recipient()
  if (!to) {
    logger.warn('Supplier payables sweep: no recipient configured, skipping email')
    return { sent: false, suppliers: dues.length, total, overdue, reason: 'No notification email configured' }
  }

  const rows = dues
    .map(
      (d) =>
        `<tr>` +
        `<td style="padding:6px;border-bottom:1px solid #eee">${escapeHtml(d.supplier ?? 'Unknown')}` +
        `<div style="color:#999;font-size:11px">${d.invoiceCount} invoice(s)` +
        (d.d60plus > 0 ? ` · <span style="color:#c0392b">${inr(d.d60plus)} over 60d</span>` : '') +
        (d.d31_60 > 0 ? ` · ${inr(d.d31_60)} 31–60d` : '') +
        (d.d1_30 > 0 ? ` · ${inr(d.d1_30)} 1–30d` : '') +
        `</div></td>` +
        `<td style="padding:6px;border-bottom:1px solid #eee;text-align:right">${inr(d.balance)}</td></tr>`,
    )
    .join('')

  const sent = await sendEmail({
    to,
    subject: `Supplier payables — ${inr(total)} outstanding (${dues.length} supplier${dues.length === 1 ? '' : 's'})`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;padding:20px">
        <h2 style="color:#1a1a2e">Supplier payables</h2>
        <p>
          <strong>${inr(total)}</strong> outstanding across ${dues.length} supplier(s).
          ${overdue > 0 ? `<span style="color:#c0392b">${inr(overdue)} is past due.</span>` : 'Nothing is past due yet.'}
        </p>
        <table style="width:100%;border-collapse:collapse;margin:12px 0">
          <tr><th align="left" style="padding:6px">Supplier</th><th align="right" style="padding:6px">Balance</th></tr>
          ${rows}
          <tr><td style="padding:6px;font-weight:bold">Total</td>
              <td align="right" style="padding:6px;font-weight:bold">${inr(total)}</td></tr>
        </table>
        <p style="color:#999;font-size:12px">Sent daily by Opal Line ERP. Record payments in Reports → Supplier Dues.</p>
      </div>`,
  })

  if (!sent) {
    logger.error({ to }, 'Supplier payables sweep: email failed')
    return { sent: false, suppliers: dues.length, total, overdue, reason: 'Failed to send summary' }
  }

  lastRunKey = today
  void recordActivity({
    action: 'Supplier payables summary sent',
    module: 'purchase',
    entity: `${dues.length} supplier(s)`,
    details: `${inr(total)} outstanding, ${inr(overdue)} past due`,
  }).catch(() => undefined)
  logger.info({ suppliers: dues.length, total, overdue }, 'Supplier payables sweep complete')
  return { sent: true, suppliers: dues.length, total, overdue }
}

const scheduler = createScheduler({
  label: 'Supplier payables sweep',
  msUntilNextRun,
  run: () => runSupplierPayables(),
  // The original re-armed in `.finally`, so a slow sweep delayed the next one.
  mode: 'run-then-rearm',
  onError: (err) => logger.error({ err }, 'Supplier payables sweep failed'),
})

export function startSupplierPayables(): void {
  if (scheduler.armed) return
  scheduler.schedule()
  logger.info(
    { next: new Date(Date.now() + msUntilNextRun()).toISOString() },
    'Supplier payables scheduler started (daily 09:20)',
  )
}

export function stopSupplierPayables(): void {
  scheduler.stop()
}

/** Test seam: has today's sweep already gone out? */
export function lastSweepDay(): string {
  return lastRunKey
}

export function resetSweepForTests(): void {
  lastRunKey = ''
}