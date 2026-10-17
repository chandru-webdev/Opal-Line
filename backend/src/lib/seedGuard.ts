/**
 * Guards for `db:seed` — the only destructive script in the repo (it truncates
 * core tables before inserting demo data). Pure helpers so they can be unit
 * tested without a database; the CLI wiring lives in src/db/seed.ts.
 */

const URL_RE = /^postgres(?:ql)?:\/\/(?:[^@/]*@)?(\[[^\]]+\]|[^:/]+)(?::(\d+))?\/([^\s?#]+)/

/** host:port/database for a postgres URL, with any credentials stripped. */
export function describeDatabaseTarget(url: string): string {
  const m = URL_RE.exec(url.trim())
  if (!m) return '(unparseable DATABASE_URL)'
  const host = m[1].replace(/^\[|\]$/g, '')
  const port = m[2] ?? '5432'
  return `${host}:${port}/${m[3]}`
}

/**
 * True when the URL points at the desktop app's bundled database — the
 * portable PostgreSQL the installed app owns (127.0.0.1:47193, database
 * opal_line). `db:seed` refuses to truncate it without an explicit --force.
 */
export function isDesktopAppDatabase(url: string): boolean {
  const m = URL_RE.exec(url.trim())
  if (!m) return false
  const host = m[1].replace(/^\[|\]$/g, '')
  const port = m[2] ?? '5432'
  const db = m[3]
  return (host === '127.0.0.1' || host === 'localhost') && port === '47193' && db === 'opal_line'
}
