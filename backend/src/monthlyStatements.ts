import { sql } from 'drizzle-orm'
import { db } from './db/client'
import * as schema from './db/schema'
import { logger } from './logger'
import { generateCustomerStatementPDF } from './statements'
import { notifyCustomerStatement } from './notifications'
import { loadNotificationPrefs } from './notificationPrefs'
import { createScheduler } from './lib/scheduler'

/**
 * Monthly customer statements: on the 1st of each month at 08:30 local time,
 * email every customer (that has an email) their account statement PDF.
 */
const DAY = 1
const HOUR = 8
const MINUTE = 30

function msUntilNextRun(now = new Date()): number {
  const next = new Date(now)
  next.setDate(DAY)
  next.setHours(HOUR, MINUTE, 0, 0)
  if (next.getTime() <= now.getTime()) {
    next.setMonth(next.getMonth() + 1)
    next.setDate(DAY)
  }
  return next.getTime() - now.getTime()
}

export async function runMonthlyStatements(): Promise<void> {
  try {
    if (!db) return
    const prefs = await loadNotificationPrefs()
    if (!prefs.monthlyStatementsEnabled) {
      logger.info('Monthly customer statements skipped — disabled in notification settings')
      return
    }
    // customers with an email and at least one invoice
    const rows = await db
      .select({ customer: schema.salesInvoices.customer, email: schema.customers.email })
      .from(schema.salesInvoices)
      .innerJoin(schema.customers, sql`${schema.customers.name} = ${schema.salesInvoices.customer}`)
      .where(sql`${schema.customers.email} is not null and ${schema.customers.email} <> ''`)
      .groupBy(schema.salesInvoices.customer, schema.customers.email)

    let sent = 0
    let failed = 0
    for (const row of rows) {
      if (!row.customer || !row.email) continue
      try {
        const statement = await generateCustomerStatementPDF(row.customer)
        if (!statement) continue
        const ok = await notifyCustomerStatement(row.email, row.customer, statement)
        if (ok) sent += 1
        else failed += 1
      } catch {
        failed += 1
      }
    }
    logger.info({ customers: rows.length, sent, failed }, 'Monthly customer statements run complete')
  } catch (err) {
    logger.error({ err }, 'Monthly statements failed')
  }
}

// setTimeout clamps any delay above 2^31-1 ms (~24.85 days) to 1 ms, firing
// immediately. The next 1st-of-month is routinely ~29 days out, so an unclamped
// timeout fired at once, re-armed, and ran the whole job again — a hot loop that
// pinned a core and starved the event loop (health checks stopped responding).
// The shared scheduler clamps every delay and re-checks the clock on each
// wake-up, so that clamp is now the default rather than something to remember.
const scheduler = createScheduler({
  label: 'Monthly statements',
  msUntilNextRun,
  run: () => runMonthlyStatements(),
})

export function startMonthlyStatements(): void {
  if (scheduler.armed) return
  scheduler.schedule()
  logger.info({ next: new Date(Date.now() + msUntilNextRun()).toISOString() }, 'Monthly statements scheduler started (1st, 08:30)')
}

export function stopMonthlyStatements(): void {
  scheduler.stop()
}
