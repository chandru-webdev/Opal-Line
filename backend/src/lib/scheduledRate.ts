/**
 * Pure logic for one-off SCHEDULED silver-rate changes: pick a rate and a
 * specific date/time (Asia/Kolkata) and the backend applies it then.
 *
 * Distinct from lib/rateSchedule.ts, which describes the RECURRING auto-fetch
 * (which days/time to fetch the spot rate) — this models individual future
 * rate changes an owner schedules by hand (e.g. a weekend rate set on Friday).
 *
 * Everything here is pure: no DB, no clock, no timers — unit testable.
 */

export interface PendingRateChange {
  id: string
  /** New 92.5% silver rate in ₹/gm. */
  rate: number
  /** When to apply it — ISO-8601 instant (stored as written, IST in the UI). */
  applyAt: string
  /** Who scheduled it (activity log keeps the full trail). */
  requestedBy: string | null
  /** Optional short reason shown on the queued row ("weekend rate"). */
  note?: string | null
}

/** A queued list beyond this is refused — bounds the settings JSONB row. */
export const MAX_PENDING_RATE_CHANGES = 20

/** Sanity band for a ₹/gm silver rate; mirrors the auto-fetch bounds. */
export const MIN_SCHEDULED_RATE = 0
export const MAX_SCHEDULED_RATE = 1_000_000

/** Notes are short labels, not essays — keeps the JSONB row small. */
export const MAX_RATE_NOTE_LENGTH = 120

/** True when `rate` is a usable ₹/gm value. */
export function isValidRate(rate: unknown): rate is number {
  return typeof rate === 'number' && Number.isFinite(rate) && rate > MIN_SCHEDULED_RATE && rate < MAX_SCHEDULED_RATE
}

/**
 * Trim/length-limit an optional note: blank or unusable input becomes null,
 * anything longer than MAX_RATE_NOTE_LENGTH is cut (never rejected — the note
 * must not be able to block a rate change).
 */
export function normalizeNote(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (trimmed === '') return null
  return trimmed.slice(0, MAX_RATE_NOTE_LENGTH)
}

/** Parse a user-supplied instant (ISO string / Date / epoch). Null when unusable. */
export function parseApplyAt(raw: unknown): Date | null {
  const d = raw instanceof Date ? raw : new Date(typeof raw === 'string' || typeof raw === 'number' ? raw : NaN)
  return Number.isNaN(d.getTime()) ? null : d
}

/**
 * Normalise the raw JSONB array (or whatever junk is stored) into the pending
 * list the scheduler trusts: valid entries only, unique ids, sorted by when
 * they run, capped at MAX_PENDING_RATE_CHANGES. Invalid entries are dropped
 * rather than allowed to wedge the queue.
 */
export function parsePendingRateChanges(raw: unknown): PendingRateChange[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: PendingRateChange[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    const id = typeof e.id === 'string' && e.id.trim() !== '' ? e.id.trim() : null
    const applyAt = parseApplyAt(e.applyAt)
    if (!id || !isValidRate(e.rate) || !applyAt || seen.has(id)) continue
    seen.add(id)
    out.push({
      id,
      rate: e.rate,
      applyAt: applyAt.toISOString(),
      requestedBy: typeof e.requestedBy === 'string' && e.requestedBy.trim() !== '' ? e.requestedBy.trim() : null,
      note: normalizeNote(e.note),
    })
    if (out.length >= MAX_PENDING_RATE_CHANGES) break
  }
  return out.sort((a, b) => Date.parse(a.applyAt) - Date.parse(b.applyAt))
}

/** A change is due once its instant has arrived (inclusive). */
export function isDue(change: PendingRateChange, now: Date): boolean {
  return Date.parse(change.applyAt) <= now.getTime()
}

/**
 * Epoch ms of the earliest change still in the future, or null when nothing
 * is pending — the scheduler arms on this and stops when it returns null.
 */
export function nextDueAt(list: PendingRateChange[], now: Date): number | null {
  let min: number | null = null
  for (const c of list) {
    const at = Date.parse(c.applyAt)
    if (at <= now.getTime()) continue
    if (min === null || at < min) min = at
  }
  return min
}
