/**
 * Pure scheduling logic for the silver-rate auto-update.
 *
 * The install can choose WHICH days (including weekends — many shops want a
 * Saturday/Sunday update too) and at WHAT time (Asia/Kolkata) the daily
 * spot-rate fetch runs. Everything here is pure so the day/time maths can be
 * unit tested without a database or a timer.
 */

export interface SilverRateSchedule {
  /** Weekdays the update runs on, 0=Sunday … 6=Saturday (unique, sorted). */
  days: number[]
  /** Run time in Asia/Kolkata, 'HH:MM' (24h). */
  time: string
}

/** India has a single, DST-free offset — the whole schedule maths relies on it. */
export const IST_UTC_OFFSET_MS = 5.5 * 60 * 60 * 1000

/** Shipped default: every day at 09:00 IST (the behaviour before this existed). */
export const DEFAULT_RATE_SCHEDULE: SilverRateSchedule = {
  days: [0, 1, 2, 3, 4, 5, 6],
  time: '09:00',
}

/**
 * Normalise a loosely-typed value (JSONB column, request body) into a valid
 * schedule. Anything unusable falls back to the shipped default rather than
 * ever producing a schedule that never runs:
 *   - days: keep unique integers 0–6; empty/invalid → every day
 *   - time: 'HH:MM' 24h, zero-padded; invalid → '09:00'
 */
export function parseRateSchedule(raw: unknown): SilverRateSchedule {
  const rec = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>
  const days: number[] = []
  if (Array.isArray(rec.days)) {
    for (const d of rec.days) {
      const n = typeof d === 'string' ? Number(d) : d
      if (typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 6 && !days.includes(n)) days.push(n)
    }
  }
  if (days.length === 0) days.push(...DEFAULT_RATE_SCHEDULE.days)
  days.sort((a, b) => a - b)
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(rec.time ?? '').trim())
  const time = m ? `${String(Number(m[1])).padStart(2, '0')}:${m[2]}` : DEFAULT_RATE_SCHEDULE.time
  return { days, time }
}

interface IstDateParts {
  year: number
  month: number // 1-12
  day: number
}

/** Calendar date (Y/M/D) of `now` as seen in Asia/Kolkata. */
function istDateParts(now: Date): IstDateParts {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const get = (t: string) => Number(parts.find((x) => x.type === t)?.value ?? '0')
  return { year: get('year'), month: get('month'), day: get('day') }
}

/**
 * The next instant the schedule is due, as a real Date (UTC instant).
 *
 * Scans today and the next seven calendar days (in IST) for the first enabled
 * weekday whose configured time is still ahead of `now`. With at least one
 * valid day a match always exists within 8 days; the 24h fallback is only a
 * safety net and should be unreachable for a parsed schedule.
 */
export function nextScheduledRun(now: Date, schedule: SilverRateSchedule): Date {
  const [h, m] = schedule.time.split(':').map(Number)
  // Target instant = IST wall-clock time expressed relative to UTC midnight
  // of that calendar day: UTC = IST − 5:30, hence the subtraction.
  const targetMsSinceUtcMidnight = (h || 0) * 3_600_000 + (m || 0) * 60_000 - IST_UTC_OFFSET_MS
  const ist = istDateParts(now)
  // Anchor: UTC midnight of the IST calendar date — used only to walk days
  // and read weekday numbers; no DST exists to shift it.
  const anchor = Date.UTC(ist.year, ist.month - 1, ist.day)
  for (let i = 0; i <= 7; i++) {
    const cand = new Date(anchor + i * 86_400_000)
    if (!schedule.days.includes(cand.getUTCDay())) continue
    const inst = Date.UTC(cand.getUTCFullYear(), cand.getUTCMonth(), cand.getUTCDate()) + targetMsSinceUtcMidnight
    if (inst > now.getTime()) return new Date(inst)
  }
  return new Date(now.getTime() + 24 * 3_600_000)
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** Human summary, e.g. `Every day at 09:00 IST`, `Mon–Fri at 10:30 IST`, `Sat, Sun at 08:15 IST`. */
export function describeRateSchedule(schedule: SilverRateSchedule): string {
  const set = new Set(schedule.days)
  const isEveryDay = set.size === 7
  const isWeekdays = set.size === 5 && [1, 2, 3, 4, 5].every((d) => set.has(d))
  // Display weeks starting Monday, so weekend pairs read "Sat, Sun".
  const sorted = [...set].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7))
  const label = isEveryDay
    ? 'Every day'
    : isWeekdays
      ? 'Mon–Fri'
      : sorted.map((d) => DAY_NAMES[d]).join(', ')
  return `${label} at ${schedule.time} IST`
}