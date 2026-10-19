/**
 * Applies one-off SCHEDULED silver-rate changes: the owner enters a rate and
 * a specific date/time on the Silver Rate page; this module wakes at that
 * instant, applies the rate (repricing products, pushing to Shopify) and
 * records the outcome in the activity log.
 *
 * The recurring auto-fetch lives in silverRateScheduler.ts — this module only
 * handles individually queued changes. Pending entries are cached in memory
 * and persisted to settings.scheduled_rate_changes (JSONB), so they survive
 * restarts; applied/cancelled entries are removed (the activity log keeps the
 * trail). Each queued change is applied exactly once: it leaves the queue
 * before the (fallible) apply runs, so a crash can never double-apply.
 */
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db, schema } from './db/client'
import { applySilverRate } from './shopify'
import { logger } from './logger'
import { recordActivity } from './activity'
import { createScheduler } from './lib/scheduler'
import {
  MAX_PENDING_RATE_CHANGES,
  isDue,
  isValidRate,
  nextDueAt,
  normalizeNote,
  parseApplyAt,
  parsePendingRateChanges,
  type PendingRateChange,
} from './lib/scheduledRate'

let pending: PendingRateChange[] = []
let applying = false

async function persist(): Promise<void> {
  if (!db) return
  try {
    await db
      .update(schema.settings)
      .set({ scheduledRateChanges: pending })
      .where(eq(schema.settings.id, 'app'))
  } catch (err) {
    logger.error({ err }, 'Scheduled rate changes: could not persist the queue')
  }
}

/** Read the persisted queue (startup / after restarts). Never throws. */
export async function loadScheduledRateChanges(): Promise<PendingRateChange[]> {
  if (db) {
    try {
      const [row] = await db
        .select({ value: schema.settings.scheduledRateChanges })
        .from(schema.settings)
        .where(eq(schema.settings.id, 'app'))
        .limit(1)
      pending = parsePendingRateChanges(row?.value)
    } catch (err) {
      logger.warn({ err }, 'Scheduled rate changes: could not read the queue from settings')
    }
  }
  return pending
}

export function getScheduledRateChanges(): PendingRateChange[] {
  return pending
}

/**
 * ms until the next change is due: 0 when one is ALREADY due (so the
 * scheduler runs it now — nextDueAt alone is future-only and would report
 * "nothing pending" the instant a change comes due), MAX when the queue is
 * empty (a safety wake; syncTimer stops the timer for an empty queue).
 */
function msUntilNextChange(now: Date): number {
  if (pending.some((c) => isDue(c, now))) return 0
  const at = nextDueAt(pending, now)
  return at === null ? Number.MAX_SAFE_INTEGER : Math.max(0, at - now.getTime())
}

/** Arm the timer for the next pending change; stop it when nothing is queued. */
function syncTimer(): void {
  if (pending.length === 0) {
    scheduler.stop()
    return
  }
  // Due items schedule an immediate wake (msUntilNextChange → 0); future
  // items arm the exact delay. Overdue items loaded at boot are caught here.
  scheduler.schedule()
}

/**
 * Queue a new scheduled change. Throws with a user-facing message for bad
 * input (rate, past time, queue full) — routes surface the message verbatim.
 */
export async function addScheduledRateChange(input: {
  rate: unknown
  applyAt: unknown
  requestedBy: string | null
  note?: unknown
}): Promise<{ change: PendingRateChange; changes: PendingRateChange[] }> {
  const rate = typeof input.rate === 'string' ? Number(input.rate) : input.rate
  if (!isValidRate(rate)) throw new Error('Rate must be a positive number of ₹/gm')
  const at = parseApplyAt(input.applyAt)
  if (!at) throw new Error('Schedule time must be a valid date and time')
  if (at.getTime() <= Date.now() + 60_000) {
    throw new Error('Schedule time must be at least a minute in the future')
  }
  if (pending.length >= MAX_PENDING_RATE_CHANGES) {
    throw new Error(`At most ${MAX_PENDING_RATE_CHANGES} changes can be queued — cancel one first`)
  }
  const change: PendingRateChange = {
    id: randomUUID(),
    rate,
    applyAt: at.toISOString(),
    requestedBy: input.requestedBy,
    note: normalizeNote(input.note),
  }
  // Re-parse the merged list so sorting/normalisation/capping stay in one place.
  pending = parsePendingRateChanges([...pending, change])
  await persist()
  syncTimer()
  logger.info({ change }, 'Silver rate change scheduled')
  return { change, changes: pending }
}

/**
 * Edit a queued change in place (rate and/or time and/or note) — the
 * "realise I typed the wrong rate" path, without cancel-and-re-enter.
 * Throws user-facing messages; unknown ids throw rather than silently
 * no-op, so the UI can tell the user it already fired or was cancelled.
 */
export async function updateScheduledRateChange(
  id: string,
  input: { rate?: unknown; applyAt?: unknown; note?: unknown },
): Promise<{ change: PendingRateChange; changes: PendingRateChange[] }> {
  const existing = pending.find((c) => c.id === id)
  if (!existing) throw new Error('Scheduled change not found — it may already have been applied or cancelled')
  const rate = input.rate === undefined ? existing.rate : typeof input.rate === 'string' ? Number(input.rate) : input.rate
  if (!isValidRate(rate)) throw new Error('Rate must be a positive number of ₹/gm')
  const at = input.applyAt === undefined ? new Date(existing.applyAt) : parseApplyAt(input.applyAt)
  if (!at) throw new Error('Schedule time must be a valid date and time')
  if (at.getTime() <= Date.now() + 60_000) {
    throw new Error('Schedule time must be at least a minute in the future')
  }
  const change: PendingRateChange = {
    ...existing,
    rate,
    applyAt: at.toISOString(),
    note: input.note === undefined ? existing.note ?? null : normalizeNote(input.note),
  }
  // Re-parse so sorting/normalisation/capping stay in one place.
  pending = parsePendingRateChanges(pending.map((c) => (c.id === id ? change : c)))
  await persist()
  syncTimer()
  logger.info({ change }, 'Silver rate change edited')
  return { change, changes: pending }
}

/** Cancel a queued change. Returns the remaining list (unknown ids are a no-op). */
export async function removeScheduledRateChange(id: string): Promise<PendingRateChange[]> {
  pending = pending.filter((c) => c.id !== id)
  await persist()
  syncTimer()
  return pending
}

/** Apply everything whose time has arrived. One attempt each; audited either way. */
async function applyDueScheduledChanges(): Promise<void> {
  if (applying) return
  applying = true
  try {
    const now = new Date()
    const due = pending.filter((c) => isDue(c, now))
    if (due.length === 0) return
    // Leave the queue BEFORE the fallible apply — exactly-once, never twice.
    pending = pending.filter((c) => !isDue(c, now))
    await persist()
    for (const change of due) {
      try {
        const result = await applySilverRate(change.rate, {
          source: 'manual',
          actorName: change.requestedBy ?? 'Scheduled change',
        })
        void recordActivity({
          action: 'Scheduled Silver Rate Change Applied',
          module: 'silver-rate',
          entity: `Silver Rate ₹${change.rate.toFixed(2)}/gm`,
          details: result.ok
            ? `Scheduled for ${change.applyAt}${change.note ? ` — "${change.note}"` : ''} — ${result.affected ?? 0} repriced, ${result.updated ?? 0} pushed to Shopify`
            : `Failed: ${result.errors.join('; ') || 'unknown error'}`,
        })
        logger.info({ rate: change.rate, applyAt: change.applyAt, ok: result.ok }, 'Scheduled silver rate change processed')
      } catch (err) {
        logger.error({ err, change }, 'Scheduled silver rate change crashed')
        void recordActivity({
          action: 'Scheduled Silver Rate Change Failed',
          module: 'silver-rate',
          entity: `Silver Rate ₹${change.rate.toFixed(2)}/gm`,
          details: `Scheduled for ${change.applyAt}: ${err instanceof Error ? err.message : 'unknown error'}`,
        })
      }
    }
  } finally {
    applying = false
    syncTimer()
  }
}

const scheduler = createScheduler({
  label: 'Scheduled silver rate changes',
  // Re-evaluated on every wake-up, so queue changes always win over drift.
  // run-then-rearm: the queue is re-checked (and re-armed or stopped) only
  // after the apply settles, which also rules out a zero-delay spin.
  mode: 'run-then-rearm',
  msUntilNextRun: () => msUntilNextChange(new Date()),
  run: () => applyDueScheduledChanges(),
})

/** Startup: load the persisted queue and arm the timer if anything is due. */
export function startScheduledRateApplier(): void {
  void loadScheduledRateChanges()
    .catch(() => {})
    .finally(() => {
      syncTimer()
      logger.info({ pending: pending.length }, 'Scheduled silver-rate changes loaded')
    })
}