import argon2 from 'argon2'
import { eq } from 'drizzle-orm'
import { CONSTANTS } from './constants'
import { db, schema } from './db/client'
import { decryptSecret } from './lib/crypto'

/**
 * Superadmin recovery password.
 *
 * If the owner forgets their login password they can type the stable recovery
 * password into the normal Password box on the sign-in screen — it works as
 * the password itself, but only for owner-level accounts (Admin / Super Admin)
 * and only at the account the recovery password is presented for. It is
 * independent of the account password: changing the login password (including
 * through the recovery flow itself) never disables it, so it keeps working on
 * every future sign-in until it is rotated.
 *
 * The value is never stored in plaintext — only as an argon2id hash:
 *
 *   1. by default the built-in constant's hash
 *      (CONSTANTS.SUPERADMIN_RECOVERY_PASSWORD_HASH); the plaintext exists
 *      only in docs/recovery-password.md, and
 *   2. an optional rotated value, hashed with argon2id and kept in
 *      settings.notificationSettings.recoveryPasswordHash via
 *      Settings → Team → Recovery password.
 *
 * A rotated value written by ≤ v1.0.14 (AES-256-GCM encV1 under the app's
 * master key, recoveryPasswordEncrypted) is still honoured and is re-hashed
 * with argon2id on first use, after which the encrypted copy is dropped.
 *
 * Every use is recorded in the activity log, the login lockout still applies
 * when it is switched on for the install (Settings → Security → Login
 * lockout), and non-owner roles are rejected before any comparison.
 */

/** Roles the recovery password may ever sign in for. */
const RECOVERY_ROLES: ReadonlyArray<string> = ['Admin', 'Super Admin']

/** Key inside settings.notificationSettings holding the rotated value's argon2id hash. */
export const RECOVERY_PASSWORD_HASH_KEY = 'recoveryPasswordHash'

/**
 * Legacy key (≤ v1.0.14): AES-256-GCM ciphertext of a rotated value. Still
 * honoured for compatibility and migrated to the hash key on first use.
 */
export const RECOVERY_PASSWORD_KEY = 'recoveryPasswordEncrypted'

export function isRecoveryRole(role: unknown): boolean {
  return typeof role === 'string' && RECOVERY_ROLES.includes(role)
}

/** The app settings' notificationSettings object ({} when no database is available). */
async function notificationSettings(): Promise<Record<string, unknown>> {
  if (!db) return {}
  try {
    const [row] = await db
      .select({ notificationSettings: schema.settings.notificationSettings })
      .from(schema.settings)
      .where(eq(schema.settings.id, 'app'))
      .limit(1)
    const ns = row?.notificationSettings
    return ns && typeof ns === 'object' ? { ...(ns as Record<string, unknown>) } : {}
  } catch {
    return {}
  }
}

/**
 * The effective recovery password as an argon2id hash: the rotated hash when
 * one is set, otherwise the built-in constant's hash. A legacy AES-stored
 * rotated value is re-hashed here and persisted (best effort), then its
 * plaintext-capable copy is removed.
 */
export async function getRecoveryPasswordHash(): Promise<string> {
  const ns = await notificationSettings()
  const custom = ns[RECOVERY_PASSWORD_HASH_KEY]
  if (typeof custom === 'string' && custom) return custom

  const enc = ns[RECOVERY_PASSWORD_KEY]
  if (typeof enc === 'string' && enc && db) {
    try {
      const value = decryptSecret(enc)
      if (value) {
        const hash = await argon2.hash(value, { type: argon2.argon2id })
        ns[RECOVERY_PASSWORD_HASH_KEY] = hash
        delete ns[RECOVERY_PASSWORD_KEY]
        try {
          await db
            .update(schema.settings)
            .set({ notificationSettings: ns })
            .where(eq(schema.settings.id, 'app'))
        } catch {
          // Migration is best effort: this request still verifies, and the
          // hash is recomputed and retried on the next one.
        }
        return hash
      }
    } catch {
      // Fall through to the constant — a bad value must never brick login.
    }
  }
  return CONSTANTS.SUPERADMIN_RECOVERY_PASSWORD_HASH
}

/** Whether the install still uses the built-in default or a rotated value. */
export async function getRecoveryPasswordSource(): Promise<'default' | 'custom'> {
  const ns = await notificationSettings()
  const custom = ns[RECOVERY_PASSWORD_HASH_KEY]
  if (typeof custom === 'string' && custom) return 'custom'
  const enc = ns[RECOVERY_PASSWORD_KEY]
  if (typeof enc === 'string' && enc) {
    try {
      if (decryptSecret(enc)) return 'custom'
    } catch {
      // Fall through — an undecryptable legacy value behaves like the default.
    }
  }
  return 'default'
}

/**
 * Login-path check: does `provided` match the recovery password for `role`?
 * Non-owner roles are rejected without touching the database or running
 * argon2; everything else is a constant-time argon2id verification against
 * the effective hash.
 */
export async function isRecoveryLogin(role: unknown, provided: string): Promise<boolean> {
  if (!isRecoveryRole(role) || !provided) return false
  try {
    return await argon2.verify(await getRecoveryPasswordHash(), provided)
  } catch {
    return false
  }
}

/** Rotate the recovery password: store only the argon2id hash. */
export async function setRecoveryPassword(value: string): Promise<void> {
  if (!db) throw new Error('Database unavailable')
  const hash = await argon2.hash(value, { type: argon2.argon2id })
  const ns = await notificationSettings()
  ns[RECOVERY_PASSWORD_HASH_KEY] = hash
  delete ns[RECOVERY_PASSWORD_KEY] // never keep a plaintext-capable legacy copy
  await db
    .update(schema.settings)
    .set({ notificationSettings: ns })
    .where(eq(schema.settings.id, 'app'))
}

/** Drop the rotated value — the built-in constant becomes effective again. */
export async function clearRecoveryPassword(): Promise<void> {
  if (!db) throw new Error('Database unavailable')
  const ns = await notificationSettings()
  delete ns[RECOVERY_PASSWORD_HASH_KEY]
  delete ns[RECOVERY_PASSWORD_KEY]
  await db
    .update(schema.settings)
    .set({ notificationSettings: ns })
    .where(eq(schema.settings.id, 'app'))
}
