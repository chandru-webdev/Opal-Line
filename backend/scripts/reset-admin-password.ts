import 'dotenv/config'
import postgres from 'postgres'
import argon2 from 'argon2'

/**
 * Set the admin login password on an EXISTING database without touching any
 * other data.
 *
 * Why this exists: fresh installs seed a known superadmin credential
 * (admin / Opal@2026, see db/bootstrap.ts), but a database created before
 * that change keeps whatever admin password it was first given — so teammates
 * cloning the project and running `npm run dev` against their own local
 * database cannot log in with the documented default. `npm run db:seed` is
 * NOT the fix: it truncates every business table.
 *
 * Usage:
 *   npm run auth:reset                    # sets admin / Opal@2026
 *   SEED_ADMIN_PASSWORD=Other#1 npm run auth:reset
 *   npm run auth:reset -- someusername    # reset a different account
 *
 * Effect: updates password_hash + require_password_change for the target
 * user, and clears that account's failed-login counters so a lockout cannot
 * hide a freshly reset password. Nothing else is written.
 */

const arg = process.argv[2]?.trim()
const targetUsername = arg || process.env.RESET_ADMIN_USERNAME?.trim() || 'admin'
const newPassword = process.env.SEED_ADMIN_PASSWORD?.trim() || 'Opal@2026'

const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL is not set. Run scripts/dev.mjs (npm run dev) once, or copy backend/.env.example to backend/.env.')
  process.exit(1)
}

async function main(): Promise<void> {
  const sql = postgres(url!, { max: 1, connect_timeout: 10 })
  try {
    const users = await sql`
      SELECT id, username, email, role FROM users
      WHERE username = ${targetUsername} OR email = ${targetUsername}
      LIMIT 1`
    if (users.length === 0) {
      const existing = await sql`SELECT username FROM users ORDER BY username`
      console.error(`No user "${targetUsername}" found. Existing usernames: ${existing.map((r: { username: string | null }) => r.username ?? '(none)').join(', ') || '(no users)'}`)
      process.exit(1)
    }
    const user = users[0] as { id: string; username: string | null; email: string; role: string }
    const passwordHash = await argon2.hash(newPassword, { type: argon2.argon2id })
    await sql`
      UPDATE users SET password_hash = ${passwordHash}, require_password_change = false
      WHERE id = ${user.id}`
    // A previous lockout must not hide the fresh password: drop this
    // account's failed-attempt counters (same tables the login route uses).
    const identifier = user.username ?? user.email
    await sql`DELETE FROM login_attempts WHERE identifier IN (${identifier}, ${user.email})`
    await sql`DELETE FROM rate_limit_hits WHERE key LIKE ${'auth:%'}`
    console.log(`Password reset for "${identifier}" (role ${user.role}).`)
    console.log(`Sign in with username "${identifier}" and the password you just set.`)
  } finally {
    await sql.end({ timeout: 5 })
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
