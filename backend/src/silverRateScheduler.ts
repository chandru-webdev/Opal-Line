import { eq } from 'drizzle-orm'
import { db, schema } from './db/client'
import { applySilverRate } from './shopify'
import { logger } from './logger'
import { createScheduler } from './lib/scheduler'
import { nextScheduledRun, parseRateSchedule, type SilverRateSchedule } from './lib/rateSchedule'

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

// The install's configured run days/time (Settings → Silver Rate →
// schedule). Loaded from the settings row at startup, refreshed after every
// run and whenever the schedule is changed over the API — the scheduler's
// `msUntilNextRun` is synchronous, so it reads this cache.
let currentSchedule: SilverRateSchedule = parseRateSchedule(null)

function msUntilNextRun(now = new Date()): number {
  return Math.max(0, nextScheduledRun(now, currentSchedule).getTime() - now.getTime())
}

/** Result of the last auto/manual spot-rate fetch, for the settings UI. */
export interface SilverRateSchedulerStatus {
  enabled: boolean
  /** The configured run days/time this install uses. */
  schedule: SilverRateSchedule
  nextRunAt: string
  lastRunAt: string | null
  lastResult: 'success' | 'failed' | 'skipped' | null
  lastRate: number | null
  lastError: string | null
  /** When non-null, a manual fetch is currently in flight. */
  fetching: boolean
}

const status: SilverRateSchedulerStatus = {
  enabled: false,
  schedule: currentSchedule,
  nextRunAt: new Date(Date.now() + msUntilNextRun()).toISOString(),
  lastRunAt: null,
  lastResult: null,
  lastRate: null,
  lastError: null,
  fetching: false,
}

export function getSchedulerStatus(): SilverRateSchedulerStatus {
  return {
    ...status,
    schedule: currentSchedule,
    nextRunAt: nextScheduledRun(new Date(), currentSchedule).toISOString(),
    enabled: scheduler.armed,
    fetching: status.fetching,
  }
}

/**
 * Fetch the current silver spot rate (INR/gram) from a configurable HTTP API.
 * Configure via env:
 *   SILVER_RATE_API_URL  — full URL of a JSON endpoint returning a price
 *   SILVER_RATE_API_KEY  — optional API key sent as x-access-token
 * The response may use any of several common shapes (rate / price / silver).
 * Returns null when unconfigured or on any failure — never guesses a price.
 */
export async function fetchSilverSpotRate(): Promise<number | null> {
  const url = process.env.SILVER_RATE_API_URL?.trim()
  if (!url) {
    logger.warn('Auto silver rate: SILVER_RATE_API_URL is not configured')
    status.lastError = 'SILVER_RATE_API_URL is not configured'
    return null
  }
  try {
    const headers: Record<string, string> = { accept: 'application/json' }
    const key = process.env.SILVER_RATE_API_KEY?.trim()
    if (key) headers['x-access-token'] = key
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) })
    if (!res.ok) {
      logger.warn({ status: res.status }, 'Auto silver rate: rate API returned an error status')
      status.lastError = `Rate API returned HTTP ${res.status}`
      return null
    }
    const json: unknown = await res.json()
    const candidates = [
      (json as Record<string, unknown>)?.rate,
      (json as Record<string, unknown>)?.price,
      (json as Record<string, unknown>)?.silver,
      (json as { rates?: Record<string, unknown> })?.rates?.silver,
      (json as { data?: Record<string, unknown> })?.data?.silver,
    ]
    for (const c of candidates) {
      const n = Number(c)
      if (Number.isFinite(n) && n > 0 && n < 1_000_000) return n
    }
    logger.warn({ keys: Object.keys((json as Record<string, unknown>) ?? {}) }, 'Auto silver rate: unrecognized API response shape')
    status.lastError = 'Unrecognized rate API response shape'
    return null
  } catch (err) {
    logger.warn({ err }, 'Auto silver rate: fetch failed')
    status.lastError = err instanceof Error ? err.message : 'Rate fetch failed'
    return null
  }
}

/** One auto-rate pass: fetch the spot rate and apply it. Shared by the daily
 * scheduler and the manual "Fetch now" button. */
export async function runSilverRateUpdate(): Promise<{ ok: boolean; rate: number | null; repriced?: number; pushed?: number; error?: string | null }> {
  status.lastRunAt = new Date().toISOString()
  try {
    if (!db) {
      status.lastResult = 'failed'
      return { ok: false, rate: null, error: 'Database is not configured' }
    }
    const [settings] = await db.select().from(schema.settings).limit(1)
    // Re-read the configured days/time each pass, so a schedule saved by any
    // process (or before a restart) is honoured without extra plumbing.
    currentSchedule = parseRateSchedule(settings?.rateSchedule)
    if (!settings?.autoUpdateMcx) {
      status.lastResult = 'skipped'
      return { ok: false, rate: null, error: 'Auto-update is disabled in settings' } // feature disabled — nothing to do
    }
    const rate = await fetchSilverSpotRate()
    if (rate == null) {
      status.lastResult = 'failed'
      logger.warn('Auto silver rate update skipped (no configured source or fetch failed)')
      return { ok: false, rate: null, error: status.lastError ?? 'No configured rate source' }
    }
    const result = await applySilverRate(rate, { source: 'auto' })
    if (result.ok) {
      status.lastResult = 'success'
      status.lastRate = rate
      status.lastError = null
      logger.info({ rate, repriced: result.affected ?? 0, pushed: result.updated ?? 0 }, 'Auto silver rate update completed')
      return { ok: true, rate, repriced: result.affected ?? 0, pushed: result.updated ?? 0 }
    }
    status.lastResult = 'failed'
    status.lastError = result.errors.join('; ') || 'Silver rate update failed'
    logger.error({ errors: result.errors }, 'Auto silver rate update failed')
    return { ok: false, rate, error: status.lastError }
  } catch (err) {
    status.lastResult = 'failed'
    status.lastError = err instanceof Error ? err.message : 'Auto silver rate update crashed'
    logger.error({ err }, 'Auto silver rate update crashed')
    return { ok: false, rate: null, error: status.lastError }
  }
}

const scheduler = createScheduler({
  label: 'Silver rate auto-update',
  msUntilNextRun,
  run: () => runSilverRateUpdate(),
})

/** Load the install's configured schedule (settings row) into the cache. */
export async function loadRateSchedule(): Promise<SilverRateSchedule> {
  if (db) {
    try {
      const [row] = await db
        .select({ rateSchedule: schema.settings.rateSchedule })
        .from(schema.settings)
        .where(eq(schema.settings.id, 'app'))
        .limit(1)
      currentSchedule = parseRateSchedule(row?.rateSchedule)
    } catch (err) {
      logger.warn({ err }, 'Silver rate schedule: could not read settings, using default (daily 09:00)')
    }
  }
  return currentSchedule
}

/**
 * Persist a new run schedule (Settings → Silver Rate), reload the cache and
 * re-arm the timer so the change takes effect immediately. Invalid input is
 * normalised by parseRateSchedule — a bad row can never stop the schedule
 * from running entirely.
 */
export async function applyRateSchedule(raw: unknown): Promise<SilverRateSchedule> {
  currentSchedule = parseRateSchedule(raw)
  if (db) {
    await db.update(schema.settings).set({ rateSchedule: currentSchedule }).where(eq(schema.settings.id, 'app'))
  }
  scheduler.schedule()
  logger.info({ schedule: currentSchedule }, 'Silver rate auto-update schedule updated')
  return currentSchedule
}

export function startSilverRateScheduler(): void {
  if (scheduler.armed) return
  // Pick up the install's configured days/time first; arm either way so a
  // slow/failed settings read never leaves the auto-update unscheduled.
  void loadRateSchedule()
    .catch(() => {})
    .finally(() => {
      if (scheduler.armed) return
      scheduler.schedule()
      logger.info(
        {
          next: istFileStamp(nextScheduledRun(new Date(), currentSchedule)),
          timezone: IST_TIMEZONE,
          schedule: currentSchedule,
        },
        'Silver rate auto-update scheduled',
      )
    })
}

export function stopSilverRateScheduler(): void {
  scheduler.stop()
}

/** Manual "Fetch spot rate now": runs one pass immediately regardless of the
 * daily schedule. Only works while the feature is enabled in settings. */
export async function fetchSilverRateNow(): Promise<{ ok: boolean; rate: number | null; repriced?: number; pushed?: number; error?: string | null }> {
  if (status.fetching) return { ok: false, rate: null, error: 'A fetch is already in progress' }
  status.fetching = true
  try {
    return await runSilverRateUpdate()
  } finally {
    status.fetching = false
  }
}

/** Turn the daily auto-update on/off at runtime (persists via settings). */
export async function setAutoRateEnabled(enabled: boolean): Promise<void> {
  if (!db) throw new Error('Database is not configured')
  await db.update(schema.settings).set({ autoUpdateMcx: enabled })
  if (enabled) startSilverRateScheduler()
  else stopSilverRateScheduler()
}
