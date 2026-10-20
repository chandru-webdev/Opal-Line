/**
 * Pure decision logic for account lockout after repeated failed logins.
 *
 * The persistence lives in the `login_attempts` table (upsert in
 * routes/auth.ts); this module holds the decision rules so they can be unit
 * tested without a database. The SQL upsert in auth.ts mirrors exactly this
 * contract:
 *   - fewer than LOCKOUT_THRESHOLD failures inside the window → allowed
 *   - LOCKOUT_THRESHOLD or more failures inside the window → locked until
 *     window end (LOCKOUT_DURATION_MS measured from the last failure)
 *   - a fresh attempt after the window → counter restarts at 1
 */
export const LOCKOUT_THRESHOLD = 5
export const LOCKOUT_DURATION_MS = 15 * 60 * 1000

export type LockoutDecision =
  | { decision: 'allowed'; count: number }
  | { decision: 'locked'; retryableAt: number }
  | { decision: 'reset'; count: 1 }

// Bounds for the per-install values (Settings → Security → Login lockout).
// They keep a typo'd or hostile row from disabling protection (threshold 0)
// or locking every account out for a week (duration 100000).
export const LOCKOUT_MIN_THRESHOLD = 1
export const LOCKOUT_MAX_THRESHOLD = 50
export const LOCKOUT_MIN_DURATION_MINUTES = 1
export const LOCKOUT_MAX_DURATION_MINUTES = 1440 // 24 hours

/** The per-install lockout settings after clamping to sane bounds. */
export interface LockoutPolicy {
  enabled: boolean
  threshold: number    // failures inside the window that trigger the lock
  durationMs: number   // how long the account stays locked (from last failure)
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (value === null || value === undefined || value === '') return fallback
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

/**
 * Turn the raw settings row (three loosely-typed DB values) into the policy
 * the login path enforces. NULLs → shipped defaults (5 failures / 15
 * minutes); out-of-range numbers are clamped, never trusted as-is. Pure and
 * unit tested so a bad row can never lock the owner out of their own system
 * or silently drop protection.
 */
export function normalizeLockoutPolicy(row: {
  enabled?: unknown
  threshold?: unknown
  durationMinutes?: unknown
}): LockoutPolicy {
  return {
    enabled: row.enabled === true,
    threshold: clampInt(row.threshold, LOCKOUT_THRESHOLD, LOCKOUT_MIN_THRESHOLD, LOCKOUT_MAX_THRESHOLD),
    durationMs: clampInt(row.durationMinutes, LOCKOUT_DURATION_MS / 60_000, LOCKOUT_MIN_DURATION_MINUTES, LOCKOUT_MAX_DURATION_MINUTES) * 60_000,
  }
}

/**
 * Decide what should happen on a failed login given the stored attempt state.
 *
 * @param storedCount  Counter currently persisted for this identifier (0 if none).
 * @param lastAttemptMs Epoch ms of the last stored failure (undefined if none).
 * @param nowMs        Current epoch ms.
 */
export function decideLockout(
  storedCount: number,
  lastAttemptMs: number | undefined,
  nowMs: number,
): LockoutDecision {
  const withinWindow =
    lastAttemptMs !== undefined &&
    Number.isFinite(lastAttemptMs) &&
    nowMs - lastAttemptMs < LOCKOUT_DURATION_MS

  if (!withinWindow) {
    // Window has lapsed (or nothing stored): the next failure restarts at 1.
    return { decision: 'reset', count: 1 }
  }

  const count = storedCount + 1
  if (count >= LOCKOUT_THRESHOLD) {
    return { decision: 'locked', retryableAt: lastAttemptMs + LOCKOUT_DURATION_MS }
  }
  return { decision: 'allowed', count }
}
