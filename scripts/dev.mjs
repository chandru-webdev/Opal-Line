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
 * This script provisions a dev stack that is fully SEPARATE from the
 * installed desktop app, so the two never conflict:
 *
 *   - same PostgreSQL lookup order: portable <repo>/backend/pgsql → system
 *     install (Windows) → pg_ctl on PATH (other platforms)
 *   - its own cluster: %APPDATA%/Opal Line Billing Dev/pgdata on port 47194
 *     with its own .pg-password (initdb --auth=trust like the app). The
 *     desktop app keeps %APPDATA%/Opal Line Billing/pgdata on port 47193.
 *   - its own data dirs: APP_DATA_DIR/LOG_DIR point at the Dev folders, so
 *     dev uploads, backups and the .encryption-key never touch the installed
 *     app's files.
 *   - backend/.env (gitignored) receives DATABASE_URL — the file every
 *     backend entry point already reads (dev, dev:server, db:seed,
 *     typecheck).
 *
 * Ports (block 47191-47198 shared with electron/main.ts): dev backend 47191,
 * desktop backend 47192, desktop PostgreSQL 47193, dev PostgreSQL 47194.
 * Both stacks can run at once without sharing anything.
 *
 * The separation matters at login too: sessions are valid per database and
 * the backend allows one active session per user, so sharing one cluster
 * meant a dev login silently logged the desktop app out (and vice versa).
 * Each environment now has its own users, sessions and data.
 *
 * A legacy backend/.env whose DATABASE_URL still points at the desktop app's
 * cluster (127.0.0.1:47193/opal_line — written by older versions of this
 * script) is migrated to the dev cluster automatically. Any other explicit
 * DATABASE_URL is honored untouched.
 *
 * The same migration also covers encV1 secrets in backend/.env (SHOPIFY_*,
 * …): they were encrypted with AES-256-GCM under the desktop app's master
 * key while dev shared that data folder. Once APP_DATA_DIR points at the dev
 * folder those values no longer decrypt — the backend logs "decryptSecret
 * failed" and reports shopifyConfigured:false — so any value the current key
 * cannot open is re-encrypted under the dev key (using the app's key as the
 * source of truth). Idempotent; node:crypto only, no backend imports.
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
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const ENV_PATH = join(ROOT, 'backend', '.env')
const EXE = process.platform === 'win32' ? '.exe' : ''

// Port block shared with electron/main.ts: dev backend 47191, desktop backend
// 47192, desktop PostgreSQL 47193, dev PostgreSQL 47194.
const PG_PORT = 47194
const DB_NAME = 'opal_line'

// Same base folder electron's app.getPath('appData') resolves to per
// platform. The desktop app owns 'Opal Line Billing' (cluster on 47193); the
// dev stack gets a sibling folder with its own cluster (47194), uploads,
// backups and encryption key — the two never share state.
function appDataDir(name = 'Opal Line Billing') {
  if (process.platform === 'win32') {
    return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), name)
  }
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', name)
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), name)
}

const APP_DATA = appDataDir('Opal Line Billing Dev')
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

/**
 * True for the URL older versions of this script wrote into backend/.env:
 * the DESKTOP APP's cluster (127.0.0.1:47193) with either the desktop's
 * bundled database (`opal_line`) or the short-lived same-cluster dev
 * database (`opal_line_dev`). Both layouts shared the desktop app's cluster
 * with dev — sessions, users and files collided. Such URLs were
 * machine-generated, never hand-maintained, so dev.mjs migrates them to the
 * separate dev cluster on the next run. Every other DATABASE_URL is treated
 * as hand-maintained and left alone.
 */
function isLegacySharedDbUrl(url) {
  const target = parseDbUrl(url)
  return (
    target?.host === '127.0.0.1' &&
    target.port === 47193 &&
    /^postgres(?:ql)?:\/\/[^/]+\/opal_line(?:_dev)?\/?$/.test(url)
  )
}

/**
 * True for the URL this script itself provisions (the dev cluster on
 * 127.0.0.1:47194). Such a line must never make `npm run dev` die: the
 * cluster not answering simply means it isn't running yet (reboot, stopped
 * session), which provisionDatabase() fixes by starting it.
 */
function isOwnDevDbUrl(url) {
  const target = parseDbUrl(url)
  return target?.host === '127.0.0.1' && target.port === PG_PORT
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

// ── encV1 secret re-homing ─────────────────────────────────────────────────────
// Mirrors backend/src/lib/crypto.ts: value = 'encV1:' + base64(iv[16] +
// tag[16] + ciphertext) under AES-256-GCM with a 32-byte key.
const ENV_ENC_PREFIX = 'encV1:'

/** Read a 32-byte hex master key file; null when absent/invalid. */
function readAesKeyFile(file) {
  try {
    if (!file || !existsSync(file)) return null
    const raw = readFileSync(file, 'utf8').trim()
    return Buffer.from(raw, 'hex').length === 32 ? raw : null
  } catch {
    return null
  }
}

function aesDecrypt(keyHex, payloadB64) {
  const key = Buffer.from(String(keyHex).trim(), 'hex')
  const buf = Buffer.from(payloadB64, 'base64')
  if (buf.length < 33) throw new Error('ciphertext too short')
  const decipher = createDecipheriv('aes-256-gcm', key, buf.subarray(0, 16))
  decipher.setAuthTag(buf.subarray(16, 32))
  return decipher.update(buf.subarray(32), undefined, 'utf8') + decipher.final('utf8')
}

function aesEncrypt(keyHex, plaintext) {
  const key = Buffer.from(String(keyHex).trim(), 'hex')
  const iv = randomBytes(16)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return ENV_ENC_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64')
}

/**
 * Re-encrypt every encV1 value in an env file that the CURRENT key cannot
 * open, using `sourceKeyFile` (the desktop app's master key) as the source of
 * truth. The current key file is created if a migration needs it and it does
 * not exist yet (same behaviour as backend/src/lib/crypto.ts). Idempotent:
 * values the current key already opens are left byte-for-byte untouched.
 *
 * Returns { migrated, failed } (env-var key names) so callers can report.
 */
export function migrateEncryptedEnvValues({ envPath, currentKeyFile, sourceKeyFile } = {}) {
  const file = envPath ?? ENV_PATH
  if (!existsSync(file)) return { migrated: [], failed: [] }
  const content = readFileSync(file, 'utf8')
  const eol = content.includes('\r\n') ? '\r\n' : '\n'
  const lines = content.split(/\r?\n/)
  const dataDir = envFileValue(file, 'APP_DATA_DIR')
  // Where the BACKEND will look for the key: APP_DATA_DIR when set, else the
  // backend's working directory (crypto.ts keyFilePath()).
  const currentFile = currentKeyFile ?? (dataDir ? join(dataDir, '.encryption-key') : join(ROOT, 'backend', '.encryption-key'))
  // The desktop app's key: electron passes APP_DATA_DIR=<appData>/Opal Line
  // Billing/data (crypto.ts then reads .encryption-key inside it). Try both
  // layouts so a hand-set APP_DATA_DIR pointing at the root still resolves.
  const sourceFile = sourceKeyFile
    ?? [join(appDataDir(), 'data', '.encryption-key'), join(appDataDir(), '.encryption-key')].find((p) => existsSync(p))
    ?? join(appDataDir(), 'data', '.encryption-key')
  let currentKey = readAesKeyFile(currentFile)
  const sourceKey = readAesKeyFile(sourceFile)
  const migrated = []
  const failed = []
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z0-9_]+)=encV1:(.+)$/.exec(lines[i])
    if (!m) continue
    const key = m[1]
    const payload = m[2]
    if (currentKey) {
      try {
        aesDecrypt(currentKey, payload)
        continue // already decryptable with the backend's key
      } catch { /* fall through to the source key */ }
    }
    let plain = null
    if (sourceKey && sourceKey !== currentKey) {
      try { plain = aesDecrypt(sourceKey, payload) } catch { plain = null }
    }
    if (plain === null) {
      failed.push(key)
      continue
    }
    if (!currentKey) {
      currentKey = randomBytes(32).toString('hex')
      mkdirSync(dirname(currentFile), { recursive: true })
      writeFileSync(currentFile, currentKey, { mode: 0o600 })
    }
    lines[i] = `${key}=${aesEncrypt(currentKey, plain)}`
    migrated.push(key)
  }
  if (migrated.length) writeFileSync(file, lines.join(eol), 'utf8')
  return { migrated, failed }
}

function reportEncryptedMigration({ migrated, failed }) {
  if (migrated.length) {
    console.log(`[dev] Re-encrypted ${migrated.length} .env secret(s) under the dev encryption key: ${migrated.join(', ')}`)
  }
  if (failed.length) {
    console.log(
      `[dev] WARNING: could not decrypt ${failed.join(', ')} in backend/.env with either key — ` +
      'the backend treats them as unset (e.g. shopifyConfigured:false). Re-enter them in the UI or .env.',
    )
  }
}

/**
 * backend/pgsql is ~1 GB and NOT in git, so a fresh checkout on another
 * machine has no server at all. Fetch the portable PostgreSQL once (the same
 * binaries the desktop installer bundles) instead of dying — this is what
 * makes `npm run dev` work out of the box on new systems. Returns true when
 * a usable server was fetched into backend/pgsql.
 */
async function ensurePortablePostgresOnce() {
  if (process.platform !== 'win32') return false
  try {
    console.log('[dev] No PostgreSQL found — downloading the portable server into backend/pgsql (~330 MB, one time)…')
    const { ensurePortablePostgres } = await import('./portable-pg.cjs')
    await ensurePortablePostgres(join(ROOT, 'backend', 'pgsql'), {
      log: (m) => console.log(`[dev]${m.trimEnd()}`),
    })
    return true
  } catch (err) {
    console.log(`[dev] Portable PostgreSQL download failed: ${err?.message ?? err}`)
    return false
  }
}

async function provisionDatabase() {
  let binDir = findPgBinDir()
  if (!binDir && (await ensurePortablePostgresOnce())) {
    binDir = findPgBinDir()
  }
  if (!binDir) {
    die(
      'No PostgreSQL found.\n' +
      '    Install PostgreSQL 15+ (https://www.postgresql.org/download/), or put the\n' +
      '    portable server in backend/pgsql/bin, or set DATABASE_URL in backend/.env,\n' +
      '    then re-run npm run dev.' +
      (process.platform === 'win32'
        ? '\n    (If the automatic portable-server download just failed, check the internet\n     connection and re-run npm run dev.)'
        : ''),
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

  // Re-home encV1 secrets first: on checkouts whose .env already points at
  // the dev data dir this is the only place it can run (the DATABASE_URL
  // early-return below would otherwise skip it); on legacy checkouts it runs
  // again after APP_DATA_DIR is rewritten further down. Idempotent.
  reportEncryptedMigration(migrateEncryptedEnvValues())

  // An explicit, reachable DATABASE_URL wins: never rewrite the file a
  // developer maintains by hand. The one exception is the legacy shared URL
  // this script itself used to write (the desktop app's cluster) — migrating
  // it is what actually separates the two stacks.
  const existing = envFileValue(ENV_PATH, 'DATABASE_URL')
  if (existing) {
    if (isLegacySharedDbUrl(existing)) {
      console.log(
        "[dev] backend/.env still points at the desktop app's cluster (127.0.0.1:47193) — " +
        'migrating to the separate dev cluster (127.0.0.1:47194).',
      )
    } else {
      const target = parseDbUrl(existing)
      const ownDevCluster = isOwnDevDbUrl(existing)
      if (target && !ownDevCluster) {
        if (await tcpOpen(target.host, target.port)) {
          console.log(`[dev] Using DATABASE_URL from backend/.env (${target.host}:${target.port})`)
          return
        }
        die(
          `backend/.env sets DATABASE_URL but ${target ? `${target.host}:${target.port}` : 'its host could not be parsed'} is not reachable.\n` +
          '    Fix that line (or delete it to let npm run dev provision its own\n' +
          '    local PostgreSQL for the dev stack), then re-run npm run dev.',
        )
      }
      // Our own line: never die on the URL this script wrote. If the cluster
      // is up, use it as-is; if not (reboot / stopped session), fall through
      // so provisionDatabase() starts it again.
      if (await tcpOpen('127.0.0.1', PG_PORT)) {
        console.log(`[dev] Using DATABASE_URL from backend/.env (127.0.0.1:${PG_PORT})`)
        return
      }
      console.log(`[dev] DATABASE_URL targets the dev cluster (127.0.0.1:${PG_PORT}) which is not running — starting it.`)
    }
  }

  const url = await provisionDatabase()
  upsertEnvValue(ENV_PATH, 'DATABASE_URL', url)
  // Dev's OWN folders (uploads, backups, encryption key) — never the desktop
  // app's, so the two stacks can't touch each other's data.
  upsertEnvValue(ENV_PATH, 'APP_DATA_DIR', DATA_DIR.replace(/\\/g, '/'))
  upsertEnvValue(ENV_PATH, 'LOG_DIR', LOG_DIR.replace(/\\/g, '/'))
  // APP_DATA_DIR now points at the dev folder — re-home any encV1 secrets
  // that were encrypted under the desktop app's key (legacy shared setup).
  reportEncryptedMigration(migrateEncryptedEnvValues())

  console.log(`[dev] PostgreSQL ready on 127.0.0.1:${PG_PORT}/${DB_NAME} — DATABASE_URL written to backend/.env`)
  console.log(`[dev] Data directory: ${DATA_DIR}`)
}

// Small self-check used by scripts/dev.test.mjs — keeps the file import-safe.
export { envFileValue, upsertEnvValue, parseDbUrl, appDataDir, isLegacySharedDbUrl, isOwnDevDbUrl }

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => die(err?.message ?? String(err)))
}
