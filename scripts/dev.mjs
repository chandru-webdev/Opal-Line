#!/usr/bin/env node
/**
 * `npm run dev` bootstrap — make plain-Node dev self-contained.
 *
 * Previously `npm run dev` started the backend and Vite with no database
 * behind them: on a fresh checkout backend/.env doesn't exist, DATABASE_URL is
 * unset, and every DB endpoint answers 503 (login included). Running the app
 * "on Node" only worked after hand-copying .env.example and installing
 * PostgreSQL yourself.
 *
 * This script provisions exactly the way the desktop app does
 * (electron/main.ts → ensurePostgres), so dev and the installed app share one
 * database instead of drifting into two:
 *
 *   - same PostgreSQL lookup order: portable <repo>/backend/pgsql → system
 *     install (Windows) → pg_ctl on PATH (other platforms)
 *   - same cluster: %APPDATA%/Opal Line Billing/pgdata on port 47193, password
 *     in the same .pg-password file (initdb --auth=trust like the app)
 *   - same data dirs: APP_DATA_DIR/LOG_DIR point at the desktop app's folders,
 *     so uploads, backups and the .encryption-key (which unlocks DB-stored
 *     secrets) are shared, and backend/.env (gitignored) receives
 *     DATABASE_URL — the file every backend entry point already reads
 *     (dev, dev:server, db:seed, typecheck).
 *
 * The dev backend (47191) and the installed app's backend (47192) use
 * deliberately distinct ports — by design they can run at once against this
 * one Postgres (47193).
 *
 * Exit 0 → package.json runs the usual `concurrently` dev stack behind `&&`.
 * Exit 1 with a reason on stdout if the database can't be provisioned.
 *
 * Escape hatch: DEV_SKIP_DB=1 skips provisioning entirely (e.g. you maintain
 * backend/.env yourself — an existing, reachable DATABASE_URL there is always
 * honored without touching the file).
 */
import { execFileSync, execSync, spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const ENV_PATH = join(ROOT, 'backend', '.env')
const EXE = process.platform === 'win32' ? '.exe' : ''

// Port block shared with electron/main.ts: dev backend 47191, desktop backend
// 47192, PostgreSQL 47193.
const PG_PORT = 47193
const DB_NAME = 'opal_line'

// Same folder electron's app.getPath('appData') resolves to per platform, so
// dev and the desktop app literally share one data directory.
function appDataDir() {
  const name = 'Opal Line Billing'
  if (process.platform === 'win32') {
    return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), name)
  }
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', name)
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), name)
}

const APP_DATA = appDataDir()
const PGDATA = join(APP_DATA, 'pgdata')
const DATA_DIR = join(APP_DATA, 'data')
const LOG_DIR = join(APP_DATA, 'logs')
const PG_PASSWORD_FILE = join(APP_DATA, '.pg-password')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function die(msg) {
  console.error(`[dev] ${msg}`)
  process.exit(1)
}

/** Read KEY=value from a dotenv-style file (comments/blank lines ignored). */
function envFileValue(file, key) {
  if (!existsSync(file)) return ''
  const m = readFileSync(file, 'utf8').match(new RegExp(`^${key}=(.*)$`, 'm'))
  return m ? m[1].trim() : ''
}

/**
 * Insert or replace a KEY=value line in backend/.env without disturbing the
 * rest of the file (comments, other settings, the user's edits).
 */
function upsertEnvValue(file, key, value) {
  const content = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const line = `${key}=${value}`
  const next = new RegExp(`^${key}=.*$`, 'm').test(content)
    ? content.replace(new RegExp(`^${key}=.*$`, 'm'), line)
    : `${line}\n${content}`
  writeFileSync(file, next, 'utf8')
}

/** Parse host/port out of a postgres:// URL without a driver (no deps here). */
function parseDbUrl(url) {
  const m = /^postgres(?:ql)?:\/\/(?:[^@/]+@)?(\[[^\]]+\]|[^:/]+)(?::(\d+))?/.exec(url)
  if (!m) return null
  return { host: m[1].replace(/^\[|\]$/g, ''), port: m[2] ? Number(m[2]) : 5432 }
}

async function tcpOpen(host, port, ms = 3000) {
  const { connect } = await import('node:net')
  return new Promise((resolveProbe) => {
    let settled = false
    const done = (ok) => {
      if (settled) return
      settled = true
      sock.destroy()
      resolveProbe(ok)
    }
    const sock = connect({ host, port })
    sock.setTimeout(ms, () => done(false))
    sock.once('connect', () => done(true))
    sock.once('error', () => done(false))
  })
}

/** Locate the PostgreSQL binaries: portable checkout → system → PATH. */
function findPgBinDir() {
  const candidates = [join(ROOT, 'backend', 'pgsql', 'bin')]
  if (process.platform === 'win32') {
    for (const v of ['17', '16', '15']) {
      candidates.push(`C:\\Program Files\\PostgreSQL\\${v}\\bin`)
    }
  }
  for (const dir of candidates) {
    if (existsSync(join(dir, `pg_ctl${EXE}`))) return dir
  }
  try {
    const out = execSync(
      process.platform === 'win32' ? 'where pg_ctl' : 'command -v pg_ctl',
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, windowsHide: true },
    )
    const found = out.split(/\r?\n/).map((s) => s.trim()).find(Boolean)
    if (found && existsSync(found)) return dirname(found)
  } catch { /* not on PATH */ }
  return null
}

function pgPassword() {
  try {
    if (existsSync(PG_PASSWORD_FILE)) {
      const pw = readFileSync(PG_PASSWORD_FILE, 'utf8').trim()
      if (pw) return pw
    }
  } catch { /* regenerate below */ }
  const pw = randomBytes(16).toString('base64url')
  mkdirSync(dirname(PG_PASSWORD_FILE), { recursive: true })
  writeFileSync(PG_PASSWORD_FILE, pw, { mode: 0o600 })
  return pw
}

/**
 * Start the cluster with pg_ctl -w, retrying transient failures.
 *
 * Never stdio:'pipe' here: pg_ctl launches postgres.exe which inherits the
 * pipe, so execFileSync would block until the DATABASE exits and the timeout
 * would kill a perfectly healthy server (documented in electron/main.ts —
 * seen live as "server started" followed by "immediate shutdown" x3). Route
 * output to a log file and verify the port ourselves instead.
 */
async function startPostgres(pgCtl) {
  mkdirSync(LOG_DIR, { recursive: true })
  const pgctlLog = join(LOG_DIR, 'pgctl.log')
  const serverLog = join(LOG_DIR, 'postgres.log')
  const portOpen = () => tcpOpen('127.0.0.1', PG_PORT, 1500)

  for (let attempt = 1; attempt <= 3; attempt++) {
    if (await portOpen()) return
    const fd = openSync(pgctlLog, 'a')
    let spawnOk = false
    try {
      execFileSync(pgCtl, [
        '-D', PGDATA,
        '-o', `-p ${PG_PORT}`,
        '-l', serverLog,
        'start', '-w', '-t', '15',
      ], { stdio: ['ignore', fd, fd], timeout: 45000, windowsHide: true })
      spawnOk = true
    } catch (err) {
      // Clear stale pid/crash state before retrying.
      try {
        execFileSync(pgCtl, ['-D', PGDATA, 'stop', '-m', 'immediate'],
          { stdio: 'ignore', timeout: 5000, windowsHide: true })
      } catch { /* not running — expected */ }
      if (attempt === 3) {
        throw new Error(
          `pg_ctl start failed after 3 attempts: ${err.message}\n` +
          `    See ${serverLog} and ${pgctlLog}`,
        )
      }
    } finally {
      closeSync(fd)
    }
    if (spawnOk) {
      for (let i = 0; i < 20; i++) {
        if (await portOpen()) return
        await sleep(250)
      }
    }
    if (attempt < 3) await sleep(1500)
  }
  if (await portOpen()) return
  throw new Error(`PostgreSQL is not listening on 127.0.0.1:${PG_PORT} — see ${join(LOG_DIR, 'postgres.log')}`)
}

/** Real connection check with the backend's own driver (postgres.js). */
async function verifyConnection(url) {
  let postgres
  try {
    ({ default: postgres } = await import('postgres'))
  } catch {
    return // driver not installed from this context — /api/v1/health covers it
  }
  const sql = postgres(url, { max: 1, connect_timeout: 5 })
  try {
    await sql`select 1`
  } catch (err) {
    throw new Error(
      `PostgreSQL answers on port ${PG_PORT} but the dev connection was refused: ${err.message}\n` +
      `    Cluster: ${PGDATA} (password: ${PG_PASSWORD_FILE})`,
    )
  } finally {
    await sql.end({ timeout: 5 })
  }
}

async function provisionDatabase() {
  const binDir = findPgBinDir()
  if (!binDir) {
    die(
      'No PostgreSQL found.\n' +
      '    Install PostgreSQL 15+ (https://www.postgresql.org/download/), or put the\n' +
      '    portable server in backend/pgsql/bin, or set DATABASE_URL in backend/.env,\n' +
      '    then re-run npm run dev.',
    )
  }
  const bin = (name) => join(binDir, `${name}${EXE}`)

  for (const d of [APP_DATA, DATA_DIR, LOG_DIR]) mkdirSync(d, { recursive: true })

  if (!existsSync(join(PGDATA, 'PG_VERSION'))) {
    console.log(`[dev] Initializing PostgreSQL data directory (${PGDATA})…`)
    try {
      execFileSync(bin('initdb'), ['-D', PGDATA, '-U', 'postgres', '-E', 'UTF8', '--auth=trust'],
        { stdio: 'pipe', timeout: 120000, windowsHide: true })
    } catch (err) {
      throw new Error(`initdb failed: ${err.stderr?.toString().trim() || err.message}`)
    }
  }

  console.log(`[dev] Starting PostgreSQL on 127.0.0.1:${PG_PORT}…`)
  await startPostgres(bin('pg_ctl'))

  try {
    execFileSync(bin('createdb'),
      ['-h', '127.0.0.1', '-p', String(PG_PORT), '-U', 'postgres', DB_NAME],
      { stdio: 'pipe', timeout: 15000, windowsHide: true })
  } catch { /* database already exists */ }

  const url = `postgresql://postgres:${pgPassword()}@127.0.0.1:${PG_PORT}/${DB_NAME}`
  await verifyConnection(url)
  return url
}

async function main() {
  if (process.env.DEV_SKIP_DB === '1') {
    console.log('[dev] DEV_SKIP_DB=1 — skipping database provisioning')
    return
  }

  // An explicit, reachable DATABASE_URL wins: never rewrite the file a
  // developer maintains by hand.
  const existing = envFileValue(ENV_PATH, 'DATABASE_URL')
  if (existing) {
    const target = parseDbUrl(existing)
    if (target && await tcpOpen(target.host, target.port)) {
      console.log(`[dev] Using DATABASE_URL from backend/.env (${target.host}:${target.port})`)
      return
    }
    die(
      `backend/.env sets DATABASE_URL but ${target ? `${target.host}:${target.port}` : 'its host could not be parsed'} is not reachable.\n` +
      '    Fix that line (or delete it to let npm run dev provision the local\n' +
      '    PostgreSQL that the desktop app uses), then re-run npm run dev.',
    )
  }

  const url = await provisionDatabase()
  upsertEnvValue(ENV_PATH, 'DATABASE_URL', url)
  // Same folders the desktop app passes to its backend: uploads, backups and
  // the master encryption key are shared, so dev sees the same data.
  upsertEnvValue(ENV_PATH, 'APP_DATA_DIR', DATA_DIR.replace(/\\/g, '/'))
  upsertEnvValue(ENV_PATH, 'LOG_DIR', LOG_DIR.replace(/\\/g, '/'))

  console.log(`[dev] PostgreSQL ready on 127.0.0.1:${PG_PORT}/${DB_NAME} — DATABASE_URL written to backend/.env`)
  console.log(`[dev] Data directory: ${DATA_DIR}`)
}

// Small self-check used by scripts/dev.test.mjs — keeps the file import-safe.
export { envFileValue, upsertEnvValue, parseDbUrl, appDataDir }

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => die(err?.message ?? String(err)))
}
