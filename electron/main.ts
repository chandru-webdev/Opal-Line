import { app, BrowserWindow, shell, dialog, ipcMain } from 'electron'
import { join, resolve } from 'node:path'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, openSync, closeSync, readSync, statSync, createWriteStream, rmSync } from 'node:fs'
import { isNewerVersion, sweepDownloads } from './updatesweep'
import { execSync } from 'node:child_process'
import { randomBytes, createHash } from 'node:crypto'
import { pruneLogIfTooBig } from './logrotate'
import { consolidateUserData } from './userdata'
import { printHtml, previewHtml, pdfFromHtml, exportPagePdf, printWebContents, type PrintResult, type PdfResult, type PrintMode } from './print'
import * as https from 'node:https'

let mainWindow: BrowserWindow | null = null
let backendProcess: ChildProcess | null = null
let localPostgresStarted = false

// Dedicated desktop port — deliberately different from the dev backend port
// Opal Line uses a dedicated port block (47191-47198) chosen to avoid
// collisions with common software on any machine. The installed app uses
// 47192/47193, distinct from the dev stack (backend 47191, its own PostgreSQL
// on 47194 — see scripts/dev.mjs), so the dev server and the installed
// desktop app run at the same time without sharing anything (separate
// clusters, sessions and data dirs — a dev login cannot log the app out).
const BACKEND_PORT = 47192
const PG_PORT = 47193
const isDev = !app.isPackaged

const APP_DATA = join(app.getPath('appData'), 'Opal Line Billing')
const PGDATA = join(APP_DATA, 'pgdata')
const DATA_DIR = join(APP_DATA, 'data')
const LOG_DIR = join(APP_DATA, 'logs')

function ensureDirs(): void {
  for (const d of [APP_DATA, PGDATA, DATA_DIR, LOG_DIR]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true })
  }
}

// Electron defaults its userData folder to %APPDATA%\<package.json name>,
// which split cookies/caches/localStorage into a SECOND folder
// ("opal-line-project") next to the real app data on every fresh install.
// Redirect everything into APP_DATA before the app is ready (Chromium has not
// opened its profile yet at module load), migrating the old default folder so
// upgraded installs keep their session state.
const DEFAULT_USER_DATA = app.getPath('userData')
consolidateUserData(DEFAULT_USER_DATA, APP_DATA)
app.setPath('userData', APP_DATA)

function logLine(stream: string, text: string): void {
  const line = `[${new Date().toISOString()}] [${stream}] ${text.trimEnd()}\n`
  try {
    const f = join(LOG_DIR, isDev ? 'dev.log' : 'app.log')
    require('node:fs').appendFileSync(f, line)
    pruneLogIfTooBig(f, Buffer.byteLength(line))
  } catch { /* ignore */ }
}

function pgRoot(): string | null {
  if (isDev) {
    // Works from source (tsx electron/main.ts → __dirname = electron/) and
    // from the compiled output (electron/dist/main.js → one level deeper):
    // the portable Postgres lives at <repo>/backend/pgsql.
    const dev = [resolve(__dirname, '..'), resolve(__dirname, '..', '..')]
      .map((root) => join(root, 'backend', 'pgsql'))
      .find((p) => existsSync(p))
    return dev ?? null
  }
  const bundled = join(process.resourcesPath, 'pgsql')
  return existsSync(bundled) ? bundled : null
}

function pgBin(name: string): string | null {
  const root = pgRoot()
  if (!root) return null
  const candidates = [join(root, 'bin', `${name}.exe`), join(root, 'bin', name)]
  for (const c of candidates) if (existsSync(c)) return c
  return null
}

function haveSystemPostgres(): boolean {
  try {
    execSync('psql --version', { encoding: 'utf8', timeout: 4000, stdio: 'pipe', windowsHide: true })
    return true
  } catch { return false }
}

function systemPostgresRoot(): string | null {
  const candidates = [
    'C:\\Program Files\\PostgreSQL\\17\\bin',
    'C:\\Program Files\\PostgreSQL\\16\\bin',
    'C:\\Program Files\\PostgreSQL\\15\\bin',
  ]
  for (const c of candidates) if (existsSync(c)) return c
  return null
}

function getOrCreatePgPassword(): string {
  const pwFile = join(APP_DATA, '.pg-password')
  try {
    if (existsSync(pwFile)) {
      return readFileSync(pwFile, 'utf8').trim()
    }
  } catch { /* generate new */ }
  const pw = randomBytes(16).toString('base64url')
  try { writeFileSync(pwFile, pw, { mode: 0o600 }) } catch { /* best effort */ }
  return pw
}

// pg_ctl start used to be fire-and-forget: if it failed (e.g. the app raced
// the installer writing files), waitForPostgres gave up silently after 15s
// and the backend booted with no database — login 500 forever, no error shown.
// Start synchronously with -w, retry transient failures, and fail loudly.
function startPostgresWithRetry(pgCtl: string): void {
  const ATTEMPTS = 3
  const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    if (isPostgresRunning()) { localPostgresStarted = true; return }
    try {
      // IMPORTANT: never use stdio:'pipe' here. pg_ctl launches postgres.exe,
      // which inherits pg_ctl's pipe handles, so execFileSync would block until
      // the DATABASE exits — the timeout then kills a perfectly healthy server
      // (seen live as "server started" followed by "immediate shutdown" x3).
      // Route output to a log file and verify the port ourselves instead.
      const pgctlLog = openSync(join(LOG_DIR, 'pgctl.log'), 'a')
      try {
        execFileSync(pgCtl, [
          '-D', PGDATA,
          '-o', `"${toPgOptionPort()}"`,
          '-l', join(LOG_DIR, 'postgres.log'),
          'start', '-w', '-t', '15',
        ], { stdio: ['ignore', pgctlLog, pgctlLog], timeout: 30000, windowsHide: true })
      } finally { closeSync(pgctlLog) }
      if (isPostgresRunning()) {
        localPostgresStarted = true
        console.log(`[postgres] Started on port ${PG_PORT} (attempt ${attempt})`)
        logLine('postgres', `started on port ${PG_PORT} (attempt ${attempt})`)
        return
      }
      logLine('postgres', `attempt ${attempt}: pg_ctl returned but port ${PG_PORT} is not listening`)
    } catch (err: any) {
      console.error(`[postgres] start attempt ${attempt}/${ATTEMPTS} failed:`, err?.message)
      logLine('postgres', `start attempt ${attempt}/${ATTEMPTS} failed: ${err?.message}`)
      // Clear stale pid/crash state before retrying
      try {
        execFileSync(pgCtl, ['-D', PGDATA, 'stop', '-m', 'immediate'], { stdio: 'ignore', timeout: 5000, windowsHide: true })
      } catch { /* not running — expected */ }
    }
    if (attempt < ATTEMPTS) sleep(1500)
  }
  throw new Error(
    `PostgreSQL could not start after ${ATTEMPTS} attempts.\n\n` +
    `See the database logs for the reason:\n${join(LOG_DIR, 'postgres.log')}\n${join(LOG_DIR, 'pgctl.log')}`,
  )
}

async function ensurePostgres(): Promise<string> {
  const pgPassword = process.env.PG_PASSWORD?.trim() || getOrCreatePgPassword()
  const dbName = 'opal_line'
  const url = `postgresql://postgres:${pgPassword}@127.0.0.1:${PG_PORT}/${dbName}`

  const initdb = pgBin('initdb')
  const pgCtl = pgBin('pg_ctl')
  const createdb = pgBin('createdb')

  if (initdb && pgCtl) {
    if (!existsSync(join(PGDATA, 'PG_VERSION'))) {
      console.log('[postgres] Initializing data directory…')
      logLine('postgres', 'initdb ' + PGDATA)
      try {
        execFileSync(initdb, ['-D', PGDATA, '-U', 'postgres', '-E', 'UTF8', '--auth=trust'], { stdio: 'pipe', windowsHide: true })
      } catch (err: any) {
        console.error('[postgres] initdb failed:', err.message)
        logLine('postgres', 'initdb failed: ' + err.message)
        throw new Error(`PostgreSQL initdb failed: ${err.stderr?.toString() || err.message}`)
      }
    }
    if (!isPostgresRunning()) {
      console.log('[postgres] Starting bundled PostgreSQL…')
      logLine('postgres', 'starting bundled postgres on ' + PG_PORT)
      startPostgresWithRetry(pgCtl)
    }
    waitForPostgres(PG_PORT)
    if (createdb) {
      try {
        execFileSync(createdb, ['-h', '127.0.0.1', '-p', String(PG_PORT), '-U', 'postgres', dbName], { stdio: 'pipe', windowsHide: true })
        console.log('[postgres] Database created')
      } catch { /* already exists */ }
    }
    return url
  }

  if (haveSystemPostgres()) {
    const sysPgRootW = systemPostgresRoot()
    if (sysPgRootW) {
      const sysInitdb = join(sysPgRootW, 'initdb.exe')
      const sysPgCtl = join(sysPgRootW, 'pg_ctl.exe')
      if (existsSync(sysInitdb) && existsSync(sysPgCtl)) {
        if (!existsSync(join(PGDATA, 'PG_VERSION'))) {
          console.log('[postgres] Initializing data directory (system postgres)…')
          try {
            execFileSync(sysInitdb, ['-D', PGDATA, '-U', 'postgres', '-E', 'UTF8', '--auth=trust'], { stdio: 'pipe', windowsHide: true })
          } catch (err: any) {
            throw new Error(`PostgreSQL initdb failed: ${err.stderr?.toString() || err.message}`)
          }
        }
        if (!isPostgresRunning()) {
          startPostgresWithRetry(sysPgCtl)
        }
        waitForPostgres(PG_PORT)
        const sysCreatedb = join(sysPgRootW, 'createdb.exe')
        if (existsSync(sysCreatedb)) {
          try {
            execFileSync(sysCreatedb, ['-h', '127.0.0.1', '-p', String(PG_PORT), '-U', 'postgres', dbName], { stdio: 'pipe', windowsHide: true })
          } catch { /* exists */ }
        }
        return url
      }
    }
  }

  console.log('[postgres] No bundled/system PostgreSQL found — using DATABASE_URL from .env')
  logLine('postgres', 'no local postgres; using external DATABASE_URL')
  return ''
}

function toPgOptionPort(): string {
  return `-p ${PG_PORT}`
}

function isPostgresRunning(): boolean {
  try {
    execSync(`netstat -ano | findstr :${PG_PORT} | findstr LISTENING`, { encoding: 'utf8', timeout: 4000, stdio: 'pipe', shell: 'cmd.exe', windowsHide: true })
    return true
  } catch { return false }
}

function waitForPostgres(port: number, tries = 30): void {
  for (let i = 0; i < tries; i++) {
    if (isPostgresRunning()) return
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500)
  }
  console.warn('[postgres] Did not become ready in time — continuing')
}

function processNameForPid(pid: string): string {
  try {
    const out = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { encoding: 'utf8', timeout: 5000, stdio: 'pipe', shell: 'cmd.exe', windowsHide: true })
    const first = out.split('\n').find((l) => l.trim().startsWith('"'))
    return first ? first.split('","')[0].replace(/^"/, '') : 'unknown process'
  } catch { return 'unknown process' }
}

function pidListeningOn(port: number): string | null {
  try {
    const out = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, { encoding: 'utf8', timeout: 5000, stdio: 'pipe', shell: 'cmd.exe', windowsHide: true })
    const line = out.split('\n').find((l) => l.trim().length > 0)
    if (!line) return null
    const pid = line.trim().split(/\s+/).pop() ?? ''
    return /^\d+$/.test(pid) ? pid : null
  } catch { return null }
}

/**
 * Kill a PID and its whole process tree.
 *
 * `child.kill()` only terminates the direct child. In dev the backend is
 * spawned with `shell: true`, so the direct child is a shell and the node
 * process holding the port is its grandchild — killing the shell orphaned
 * it, which is exactly why the port stayed taken after the app closed.
 * On Windows `taskkill /T` walks the tree.
 */
function killTree(pid: number): boolean {
  try {
    execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore', timeout: 8000, windowsHide: true, shell: 'cmd.exe' })
    return true
  } catch {
    return false
  }
}

/**
 * The backend's own pid, persisted while it runs.
 *
 * Lets the next launch tell "an orphan from a previous run that never shut
 * down" apart from "some unrelated program that happens to use this port".
 * Only a PID we recorded ourselves is ever reclaimed automatically.
 */
function backendPidFile(): string {
  return join(DATA_DIR, 'backend.pid')
}

function recordBackendPid(pid: number): void {
  try { writeFileSync(backendPidFile(), String(pid)) } catch { /* best effort */ }
}

function clearBackendPid(): void {
  try { rmSync(backendPidFile(), { force: true }) } catch { /* best effort */ }
}

function recordedBackendPid(): number | null {
  try {
    const raw = readFileSync(backendPidFile(), 'utf8').trim()
    return /^\d+$/.test(raw) ? Number(raw) : null
  } catch { return null }
}

/**
 * Whether a PID is a live process.
 *
 * `tasklist` does NOT fail for a missing pid — it exits 0 and prints an INFO
 * line — so this must parse the output rather than rely on the throw path.
 * Returning true unconditionally would make the reclamation guard worthless.
 */
function isAlive(pid: number): boolean {
  try {
    const out = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { encoding: 'utf8', timeout: 5000, stdio: 'pipe', windowsHide: true, shell: 'cmd.exe' })
    // A match renders as a quoted CSV row ("node.exe","21620",…); the
    // no-match INFO line is not quoted. The pid field carries its own quotes,
    // so they must be stripped before comparing.
    return out
      .split(/\r?\n/)
      .some((l) => {
        const row = l.trim()
        if (!row.startsWith('"')) return false
        return row.split(',')[1]?.replace(/"/g, '') === String(pid)
      })
  } catch { return false }
}

/**
 * The command line of a PID, or null if it cannot be read.
 *
 * Used to guard automatic reclamation: Windows recycles PIDs, so a recorded
 * pid can, after a crash, belong to a completely unrelated program. Killing
 * on pid equality alone would terminate whatever now owns that number.
 * The port, the recorded pid AND an Opal Line command line must all agree.
 */
function processCommandLine(pid: number): string | null {
  try {
    const ps =
      "powershell.exe -NoProfile -NonInteractive -Command " +
      `"(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine"`
    const out = execSync(ps, { encoding: 'utf8', timeout: 8000, stdio: 'pipe', windowsHide: true, shell: 'cmd.exe' }).trim()
    return out && out !== 'null' ? out : null
  } catch { return null }
}

/** True when this PID is provably one of our own backend processes. */
function looksLikeOurBackend(pid: number): boolean {
  const cmd = processCommandLine(pid)
  if (!cmd) return false
  // Packaged: an Electron child whose entry lives under resources\\backend.
  if (/backend[/\\]dist[/\\]index\.cjs/i.test(cmd)) return true
  if (/opal line billing/i.test(cmd)) return true
  // Dev: spawned by `npx tsx backend/src/index.ts` from this checkout, whose
  // command line is just a bare node + tsx loader. Anchor on the checkout
  // path instead, so an unrelated node process is never matched.
  if (isDev) {
    const root = resolve(__dirname, '..').replace(/\\/g, '\\\\')
    return new RegExp(root, 'i').test(cmd)
  }
  return false
}

/**
 * Fail fast — with a human-readable reason — when the dedicated ports are
 * taken before we try to bind them. Otherwise the user only sees a long
 * startup stall or a generic EADDRINUSE crash from the backend child.
 */
function preflightPorts(): boolean {
  for (const [port, label] of [[BACKEND_PORT, 'application server'] as const, [PG_PORT, 'bundled database'] as const]) {
    const pid = pidListeningOn(port)
    if (!pid) continue

    // Reclaim an orphan from a previous run: we recorded this PID ourselves,
    // it is the process listening on the port, and its command line still
    // proves it is ours. All three must agree — a recycled PID would
    // otherwise make us kill an innocent program.
    const stale = recordedBackendPid()
    if (stale !== null && Number(pid) === stale && isAlive(stale) && looksLikeOurBackend(stale)) {
      logLine('startup', `port ${port} held by orphaned backend (pid ${pid}) from a previous run — reclaiming`)
      killTree(stale)
      clearBackendPid()
      for (let i = 0; i < 20 && pidListeningOn(port); i++) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250)
      }
      if (!pidListeningOn(port)) continue
      // Still held after a force-kill — fall through to the normal report.
    }

    const name = processNameForPid(pid)
    // PostgreSQL already listening on the bundled-database port is NOT a
    // conflict: it can be our own leftover cluster, or the dev stack
    // (scripts/dev.mjs via npm run dev / electron:dev) deliberately sharing
    // this data directory — and ensurePostgres() reuses a running server
    // rather than starting a second one. Only a non-PostgreSQL program on
    // 47193 is a real collision worth blocking startup for.
    if (port === PG_PORT && /^postgres(?:\.exe)?$/i.test(name.trim())) {
      logLine('startup', `port ${port} already served by ${name} (pid ${pid}) — reusing`)
      continue
    }
    if (/opal line billing/i.test(name)) {
      logLine('startup', `port ${port} held by another Opal Line instance (pid ${pid})`)
      dialog.showMessageBox({
        type: 'info',
        title: 'Opal Line Billing is already running',
        message: 'Opal Line Billing is already running.',
        detail: `Another instance holds the ${label} port (${port}). Check the system tray or taskbar and switch to the open window.`,
        buttons: ['OK'],
      })
    } else {
      logLine('startup', `port ${port} held by ${name} (pid ${pid})`)
      dialog.showErrorBox(
        'Port already in use',
        `The ${label} port (${port}) is used by:\n\n${name} (PID ${pid})\n\n` +
        `Close that program or change the port in:\n${join(DATA_DIR, '.env')}`,
      )
    }
    return false
  }
  return true
}

function ensureEnvFile(databaseUrl: string): { path: string; isFirstRun: boolean } {
  const envPath = join(DATA_DIR, '.env')
  const isFirstRun = !existsSync(envPath)
  if (isFirstRun) {
    const content = [
      '# Generated by Opal Line Billing on first run.',
      'PORT=47192',
      `DATABASE_URL=${databaseUrl}`,
      'ENCRYPTION_KEY=',
      'NODE_ENV=production',
      '',
    ].join('\n')
    writeFileSync(envPath, content, 'utf8')
    console.log('[env] Created first-run .env at', envPath)
  } else if (databaseUrl) {
    let content = readFileSync(envPath, 'utf8')
    if (!/^DATABASE_URL=/m.test(content)) {
      content = `DATABASE_URL=${databaseUrl}\n` + content
      writeFileSync(envPath, content, 'utf8')
    }
  }
  return { path: envPath, isFirstRun }
}

function findNode(): string {
  if (process.platform !== 'win32') return 'node'
  const candidates = [
    'C:\\Program Files\\nodejs\\node.exe',
    'C:\\Program Files (x86)\\nodejs\\node.exe',
  ]
  try {
    const path = execSync('where node', { encoding: 'utf8', timeout: 3000, windowsHide: true }).trim().split('\n')[0]
    if (path && existsSync(path)) return path
  } catch {}
  for (const c of candidates) if (existsSync(c)) return c
  return 'node'
}

function backendCommand(): { cmd: string; baseArgs: string[] } {
  const electronNode = process.execPath
  return { cmd: electronNode, baseArgs: ['--js-flags=', '-e', 'process.env.ELECTRON_RUN_AS_NODE="1";require(process.argv[1])'] }
}

function startBackend(envPath: string, managedDbUrl: string | null): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    let cwd: string
    let entry: string
    let cmd: string
    let args: string[]

    if (isDev) {
      // Same dual-layout resolution as pgRoot(): the backend lives at
      // <repo>/backend whether we run from source or from electron/dist.
      const backendDir = [resolve(__dirname, '..'), resolve(__dirname, '..', '..')]
        .map((root) => join(root, 'backend'))
        .find((p) => existsSync(join(p, 'src', 'index.ts')))
      if (!backendDir) {
        reject(new Error('backend source not found relative to ' + __dirname))
        return
      }
      cwd = backendDir
      entry = join(backendDir, 'src', 'index.ts')
      cmd = 'npx'
      // shell: true (required for npx.cmd on Windows) joins args with spaces
      // WITHOUT quoting them — in a repo path containing spaces (e.g.
      // "LONI GROUPS DM1") the entry path splits mid-argument and tsx dies
      // with ERR_MODULE_NOT_FOUND. Quote the path ourselves.
      args = ['tsx', /\s/.test(entry) ? `"${entry}"` : entry]
      backendProcess = spawn(cmd, args, {
        cwd,
        env: { ...process.env, PORT: String(BACKEND_PORT), DOTENV_CONFIG_PATH: envPath, APP_VERSION: app.getVersion(), LOG_DIR },
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: true,
        windowsHide: true,
      })
    } else {
      const backendRoot = join(process.resourcesPath, 'backend')
      cwd = backendRoot
      entry = join(backendRoot, 'dist', 'index.cjs')
      cmd = process.execPath
      args = [entry]
      const backendEnv: Record<string, string | undefined> = {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        PORT: String(BACKEND_PORT),
        NODE_ENV: 'production',
        DOTENV_CONFIG_PATH: envPath,
        APP_DATA_DIR: DATA_DIR,
        LOG_DIR,
        APP_VERSION: app.getVersion(),
        NODE_PATH: join(backendRoot, 'dist', 'node_modules'),
      }
      if (managedDbUrl) backendEnv.DATABASE_URL = managedDbUrl
      if (!backendEnv.DATABASE_URL) {
        dialog.showErrorBox(
          'Database not configured',
          'No PostgreSQL database is available.\n\n' +
          'Start the bundled database or set DATABASE_URL in:\n' + envPath,
        )
        reject(new Error('No DATABASE_URL'))
        return
      }
      console.log('[electron] Backend entry:', entry, 'exists:', existsSync(entry))
      backendProcess = spawn(cmd, args, { cwd, env: backendEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    }

    // Persist the real backend PID so a later launch can tell "our orphan"
    // apart from "someone else's program on this port". Under `shell: true`
    // (dev) this is the shell's pid, which does NOT hold the port — record
    // the listening pid once the server is up, so it matches what
    // preflightPorts() will later see.
    if (backendProcess?.pid) recordBackendPid(backendProcess.pid)

    let started = false
    const timeout = setTimeout(() => {
      if (!started) reject(new Error('Backend failed to start within 25 seconds'))
    }, 25000)

    backendProcess.stdout?.on('data', (data: Buffer) => {
      const text = data.toString()
      console.log('[backend:out]', text.trim())
      logLine('backend', text)
      if ((text.includes('Server started') || text.includes('listening')) && !started) {
        started = true
        clearTimeout(timeout)
        // Prefer the pid actually holding the port — that is the value the
        // next launch will read back in preflightPorts().
        const listener = pidListeningOn(BACKEND_PORT)
        if (listener) recordBackendPid(Number(listener))
        resolvePromise()
      }
    })

    backendProcess.stderr?.on('data', (data: Buffer) => {
      const text = data.toString()
      console.error('[backend:err]', text.trim())
      logLine('backend-err', text)
      // Port conflict fails instantly — don't make the user wait out the timeout.
      if (!started && /EADDRINUSE|already in use/i.test(text)) {
        clearTimeout(timeout)
        reject(new Error(
          `Port ${BACKEND_PORT} is already in use.\n\n` +
          'Another instance of Opal Line Billing — or the development server (npm run dev) — is already using it.\n\n' +
          'Close the other one, then reopen Opal Line Billing.',
        ))
      }
    })

    backendProcess.on('error', (err) => {
      console.error('[electron] Spawn error:', err.message)
      if (!started) { clearTimeout(timeout); reject(err) }
    })

    backendProcess.on('exit', (code) => {
      console.log(`[electron] Backend exited with code ${code}`)
      logLine('backend', `exited code ${code}`)
      backendProcess = null
      clearBackendPid()
      if (!started) {
        clearTimeout(timeout)
        reject(new Error(`The backend process exited with code ${code} before the server was ready.\n\nCheck the logs in the app data folder for details.`))
      }
    })
  })
}

// Branded startup splash — shown while Postgres and the backend boot (the
// real UI cannot load before the backend is up, and that used to leave the
// user staring at an empty desktop for seconds after clicking the icon).
const SPLASH_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Opal Line Billing</title><style>
  html, body { height: 100%; margin: 0 }
  body { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 16px;
         font-family: 'Segoe UI', system-ui, sans-serif; background: #0f172a; color: #e2e8f0 }
  .ring { width: 34px; height: 34px; border-radius: 50%; border: 3px solid #1e293b;
          border-top-color: #38bdf8; animation: spin .9s linear infinite }
  .brand { font-size: 21px; font-weight: 600; letter-spacing: .3px }
  .sub { font-size: 13px; color: #94a3b8 }
  @keyframes spin { to { transform: rotate(360deg) } }
</style></head><body>
  <div class="ring"></div>
  <div class="brand">Opal Line Billing</div>
  <div class="sub">Starting up…</div>
</body></html>`

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1024, minHeight: 600,
    title: 'Opal Line Billing',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
    show: false,
  })

  // Splash FIRST: the real UI cannot load until Postgres and the backend are
  // up (see main()), so show branded startup feedback immediately instead of
  // leaving the user with nothing after clicking the icon.
  mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(SPLASH_HTML)).catch(() => undefined)

  mainWindow.once('ready-to-show', () => mainWindow?.show())
  // Defence-in-depth: the renderer must only ever be the app's own UI. Block
  // navigations to anything else (a compromised renderer or a stray target=
  // _self link must not turn the main window into an arbitrary website).
  const appOrigins = new Set([
    isDev ? 'http://localhost:47195' : `http://localhost:${BACKEND_PORT}`,
    'http://127.0.0.1:47195',
    `http://127.0.0.1:${BACKEND_PORT}`,
    '[::1]:47195',
  ])
  const isAppUrl = (u: string): boolean => {
    try {
      const parsed = new URL(u)
      return Array.from(appOrigins).some((o) => {
        try {
          const origin = new URL(o)
          return origin.host === parsed.host && origin.protocol === parsed.protocol
        } catch { return false }
      })
    } catch { return false }
  }
  // Popups are ALWAYS denied — print flows use the print:html IPC channel now
  // (see electron/print.ts) — but the click still has to do something:
  //  - app-internal links (window.open('/api/.../download')) are file
  //    downloads: start them here, otherwise backup/statement/label
  //    downloads silently did nothing in the desktop app;
  //  - http(s) links are external (WhatsApp, Razorpay, Shopify) → system
  //    browser;
  //  - anything else (about:blank, unparseable) is simply dropped.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAppUrl(url)) mainWindow?.webContents.downloadURL(url)
    else if (/^https?:/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url)) {
      event.preventDefault()
      // Surface genuine external links in the user's browser instead.
      if (/^https?:/i.test(url)) shell.openExternal(url)
    }
  })
  mainWindow.on('closed', () => { mainWindow = null })

  // A crashed renderer used to leave a dead, white window until the user
  // restarted the app. Log it and reload the UI — at most 3 times, so a
  // genuinely broken build cannot crash-loop forever.
  let crashReloads = 0
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    logLine('electron', `renderer gone: ${details.reason} (exitCode=${details.exitCode})`)
    if (details.reason === 'clean-exit') return
    if (crashReloads >= 3) {
      logLine('electron', 'renderer crashed repeatedly — giving up on auto-reload')
      return
    }
    crashReloads++
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reload()
  })
}

function appUrl(): string {
  return isDev ? 'http://localhost:47195' : `http://localhost:${BACKEND_PORT}`
}

/** Swap the startup splash for the real app UI (backend is ready). */
function loadAppInWindow(): void {
  mainWindow?.loadURL(appUrl()).catch((err) => {
    console.error('[electron] Failed to load the app UI:', err)
    logLine('electron', 'failed to load app UI: ' + String((err as Error)?.message ?? err))
  })
}

// ── Printing ──────────────────────────────────────────────────────────────
// The renderer's print/PDF/preview flows land here (electron/print.ts) because
// the main window denies every window.open() popup. printHtml spools to the
// OS default printer silently — no dialog, no app picker.
ipcMain.handle('print:html', (_e, html: unknown, title: unknown, mode: unknown): Promise<PrintResult> | PrintResult => {
  if (typeof html !== 'string' || html.length === 0) return { ok: false, error: 'empty document' }
  return printHtml(html, {
    title: typeof title === 'string' ? title : undefined,
    mode: mode === 'dialog' ? 'dialog' : undefined,
  })
})

// The "how do you want to print?" chooser shown before every print. Native
// message box, so it works no matter which window the flow started from:
//   Default printer             → silent job to the OS default printer
//   Save as PDF…                → save a .pdf instead of printing
//   Choose printer and options… → the system print dialog (same as Ctrl+P)
//   Cancel                      → nothing is printed
ipcMain.handle('print:choose-mode', (): Promise<PrintMode | 'pdf' | 'cancel'> => {
  const options: Electron.MessageBoxOptions = {
    type: 'question',
    title: 'Print',
    message: 'How do you want to print?',
    detail:
      'Default printer — sends the job straight to your Windows default printer.\n\n' +
      'Save as PDF — saves a PDF copy instead of printing.\n\n' +
      'Choose printer and options… — opens the Windows print dialog (like Ctrl+P) ' +
      'to pick the printer, number of copies and preferences.',
    buttons: ['Default printer', 'Save as PDF…', 'Choose printer and options…', 'Cancel'],
    defaultId: 0,
    cancelId: 3,
    noLink: true,
  }
  const show = mainWindow && !mainWindow.isDestroyed()
    ? dialog.showMessageBox(mainWindow, options)
    : dialog.showMessageBox(options)
  return show.then(({ response }) =>
    response === 0 ? 'silent' : response === 1 ? 'pdf' : response === 2 ? 'dialog' : 'cancel')
})
ipcMain.handle('print:preview', (_e, html: unknown, title: unknown): Promise<PrintResult> | PrintResult => {
  if (typeof html !== 'string' || html.length === 0) return { ok: false, error: 'empty document' }
  return previewHtml(html, typeof title === 'string' ? title : undefined)
})
ipcMain.handle('export:pdf', (_e, html: unknown, suggestedName: unknown): Promise<PdfResult> | PdfResult => {
  if (typeof html !== 'string' || html.length === 0) return { ok: false, error: 'empty document' }
  return pdfFromHtml(html, {
    suggestedName: typeof suggestedName === 'string' ? suggestedName : undefined,
  })
})
// "Save as PDF" for the @media-print flows (Dashboard, DayBook, invoice
// dialog): printToPDF the app window mid print-only state, then a save dialog.
ipcMain.handle('export:pdf-page', (_e, suggestedName: unknown): Promise<PdfResult> | PdfResult => {
  if (!mainWindow || mainWindow.isDestroyed()) return { ok: false, error: 'no window to export' }
  return exportPagePdf(mainWindow.webContents, {
    suggestedName: typeof suggestedName === 'string' ? suggestedName : undefined,
  })
})
// The @media print flows (Dashboard, DayBook, invoice dialog) print the app
// window itself — silently, to the default printer.
ipcMain.handle('print:page', (_e, mode: unknown): Promise<PrintResult> | PrintResult => {
  if (!mainWindow || mainWindow.isDestroyed()) return { ok: false, error: 'no window to print' }
  return printWebContents(mainWindow.webContents, { mode: mode === 'dialog' ? 'dialog' : undefined })
})

function stopPostgres(): void {
  if (!localPostgresStarted) return
  try {
    const pgCtl = pgBin('pg_ctl') ?? join(systemPostgresRoot() ?? '', 'pg_ctl.exe')
    if (pgCtl && existsSync(PGDATA)) {
      execFileSync(pgCtl, ['-D', PGDATA, 'stop', '-m', 'fast'], { stdio: 'pipe', timeout: 10000, windowsHide: true })
    }
  } catch { /* best effort */ }
  localPostgresStarted = false
}

// ── Auto-update ──────────────────────────────────────────────────────────
// Packaged builds poll GitHub Releases for a newer v* tag, download the signed
// NSIS installer, verify its SHA-256 (release asset digest) and Authenticode
// signer subject, then relaunch it silently after the app quits. The renderer
// drives it through the preload bridge (System Status page).
const UPDATE_REPO = 'kumarboobesh765-code/Opal-Line'
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

type UpdatePhase = 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'ready' | 'error'

interface UpdateState {
  phase: UpdatePhase
  latest: string | null
  progress: number
  assetName: string | null
  assetSize: number | null
  filePath: string | null
  error: string | null
}

let updateState: UpdateState = { phase: 'idle', latest: null, progress: 0, assetName: null, assetSize: null, filePath: null, error: null }
let updateDownloadUrl: string | null = null
let updateExpectedSha256: string | null = null
let updateDialogOpen = false

// ─── Update preferences (set from the sidebar Updates page) ─────────

interface UpdatePrefs {
  /** Download updates in the background as soon as they are found. */
  autoDownload: boolean
  /** Restart and install without asking once verified. */
  autoInstall: boolean
  /** Show the amber in-app banner while an update is available/ready. */
  showBanner: boolean
}

const DEFAULT_UPDATE_PREFS: UpdatePrefs = { autoDownload: true, autoInstall: false, showBanner: true }
let updatePrefs: UpdatePrefs = { ...DEFAULT_UPDATE_PREFS }

function updatePrefsFile(): string {
  return join(DATA_DIR, 'update-prefs.json')
}

function loadUpdatePrefs(): void {
  try {
    const raw = readFileSync(updatePrefsFile(), 'utf8')
    updatePrefs = { ...DEFAULT_UPDATE_PREFS, ...JSON.parse(raw) }
  } catch { /* first run or unreadable — keep defaults */ }
}

function saveUpdatePrefs(): void {
  try {
    writeFileSync(updatePrefsFile(), JSON.stringify(updatePrefs, null, 2), 'utf8')
  } catch { /* best effort */ }
}

ipcMain.handle('updates:get-prefs', () => updatePrefs)
ipcMain.handle('updates:set-prefs', (_e, patch: Partial<UpdatePrefs>) => {
  updatePrefs = { ...updatePrefs, ...patch }
  saveUpdatePrefs()
  logLine('update', `preferences updated: autoDownload=${updatePrefs.autoDownload} autoInstall=${updatePrefs.autoInstall} showBanner=${updatePrefs.showBanner}`)
  return updatePrefs
})

ipcMain.handle('updates:status', () => publicUpdateState())

/**
 * The silent install runs in a detached helper, so a failure there is invisible
 * to the app that spawned it. The helper drops this marker instead; we read it
 * on the next launch so the user is told the update did NOT apply rather than
 * silently staying on the old version.
 */
function updateFailureFile(): string {
  return join(DATA_DIR, 'update-failure.json')
}

function readUpdateFailure(): { at: string; reason: string } | null {
  try {
    if (!existsSync(updateFailureFile())) return null
    // PowerShell 5.1 `Set-Content -Encoding UTF8` writes a BOM, which breaks JSON.parse.
    const raw = readFileSync(updateFailureFile(), 'utf8').replace(/^\uFEFF/, '')
    const parsed = JSON.parse(raw) as { at?: string; reason?: string }
    if (!parsed.reason) return null
    return { at: parsed.at ?? '', reason: parsed.reason }
  } catch { return null }
}

function publicUpdateState(): UpdateState & { current: string; lastFailure: { at: string; reason: string } | null } {
  return { ...updateState, current: app.isPackaged ? app.getVersion() : 'dev', lastFailure: readUpdateFailure() }
}

ipcMain.handle('updates:clear-failure', () => {
  try { rmSync(updateFailureFile(), { force: true }) } catch { /* best effort */ }
  return publicUpdateState()
})

function httpsGetBody(url: string, headers: Record<string, string>, timeoutMs: number, redirects = 0): Promise<{ status: number; body: string }> {
  return new Promise((resolvePromise, rejectP) => {
    const req = https.get(url, { headers, timeout: timeoutMs }, (resp) => {
      const location = resp.headers.location
      if (resp.statusCode && resp.statusCode >= 300 && resp.statusCode < 400 && location) {
        resp.resume()
        if (redirects >= 5) { rejectP(new Error('Too many redirects')); return }
        httpsGetBody(location, headers, timeoutMs, redirects + 1).then(resolvePromise, rejectP)
        return
      }
      let data = ''
      resp.setEncoding('utf8')
      resp.on('data', (chunk: string) => { data += chunk })
      resp.on('end', () => resolvePromise({ status: resp.statusCode ?? 0, body: data }))
    })
    req.on('timeout', () => req.destroy(new Error('Request timed out')))
    req.on('error', rejectP)
  })
}

function httpsDownload(url: string, dest: string, totalBytes: number, onProgress: (pct: number) => void, redirects = 0): Promise<void> {
  return new Promise((resolvePromise, rejectP) => {
    const req = https.get(url, { timeout: 60000 }, (resp) => {
      const location = resp.headers.location
      if (resp.statusCode && resp.statusCode >= 300 && resp.statusCode < 400 && location) {
        resp.resume()
        if (redirects >= 5) { rejectP(new Error('Too many redirects')); return }
        httpsDownload(location, dest, totalBytes, onProgress, redirects + 1).then(resolvePromise, rejectP)
        return
      }
      if (resp.statusCode !== 200) {
        resp.resume()
        rejectP(new Error(`Download failed (HTTP ${resp.statusCode})`))
        return
      }
      const file = createWriteStream(dest)
      let received = 0
      let lastPct = -1
      resp.on('data', (chunk: Buffer) => {
        received += chunk.length
        if (totalBytes > 0) {
          const pct = Math.min(99, Math.floor((received / totalBytes) * 100))
          if (pct !== lastPct) { lastPct = pct; onProgress(pct) }
        }
      })
      resp.pipe(file)
      file.on('finish', () => {
        file.close(() => {
          if (totalBytes > 0 && received !== totalBytes) {
            rejectP(new Error(`Download truncated (${received}/${totalBytes} bytes)`))
            return
          }
          onProgress(100)
          resolvePromise()
        })
      })
      file.on('error', rejectP)
      resp.on('error', rejectP)
    })
    req.on('timeout', () => req.destroy(new Error('Download timed out')))
    req.on('error', rejectP)
  })
}

function sha256File(file: string): string {
  const hash = createHash('sha256')
  const fd = openSync(file, 'r')
  try {
    const size = statSync(file).size
    const buf = Buffer.alloc(1024 * 1024)
    let pos = 0
    while (pos < size) {
      const read = readSync(fd, buf, 0, buf.length, pos)
      if (read <= 0) break
      hash.update(buf.subarray(0, read))
      pos += read
    }
  } finally {
    closeSync(fd)
  }
  return hash.digest('hex')
}

function verifyInstallerSignature(file: string): void {
  const escaped = file.replace(/'/g, "''")
  const script = [
    `$s = Get-AuthenticodeSignature -LiteralPath '${escaped}'`,
    'if (-not $s.SignerCertificate) { exit 2 }',
    "if ($s.Status -eq 'HashMismatch' -or $s.Status -eq 'NotSigned') { exit 3 }",
    "if ($s.SignerCertificate.Subject -notlike '*Opal Line Billing*') { exit 4 }",
    'exit 0',
  ].join('; ')
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore', timeout: 60000, windowsHide: true })
}



/**
 * Fetch the latest-release metadata with limited retry/backoff. Transient
 * network failures (DNS flap, captive portal, TLS resets) are common on shop
 * Wi-Fi; one failure shouldn't surface as an update error.
 */
async function fetchLatestRelease(): Promise<{ status: number; body: string }> {
  const url = `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`
  const headers = { 'User-Agent': 'opal-line-updater', Accept: 'application/vnd.github+json' }
  let lastErr: unknown
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await httpsGetBody(url, headers, 20000)
    } catch (err) {
      lastErr = err
      if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 3000))
    }
  }
  throw lastErr
}

async function checkForUpdates(opts: { announce: boolean }): Promise<UpdateState & { current: string }> {
  if (!app.isPackaged) {
    updateState = { ...updateState, phase: 'up-to-date' }
    return publicUpdateState()
  }
  if (updateState.phase === 'checking' || updateState.phase === 'downloading') return publicUpdateState()
  updateState = { ...updateState, phase: 'checking', error: null }
  try {
    const { status, body } = await fetchLatestRelease()
    if (status !== 200) throw new Error(`GitHub API returned HTTP ${status}`)
    const release = JSON.parse(body) as {
      tag_name?: string
      assets?: Array<{ name: string; browser_download_url: string; size: number; digest?: string }>
    }
    const latest = (release.tag_name ?? '').trim().replace(/^v/, '')
    if (!/^\d+\.\d+\.\d+/.test(latest)) throw new Error('Latest release has no usable version tag')
    const current = app.getVersion()
    if (!isNewerVersion(current, latest)) {
      updateState = { ...updateState, phase: 'up-to-date', latest }
      logLine('update', `up to date: installed ${current}, latest ${latest}`)
      return publicUpdateState()
    }
    const assets = release.assets ?? []
    const asset = assets.find((a) => /-Setup-.*\.exe$/i.test(a.name)) ?? assets.find((a) => a.name.endsWith('.exe'))
    if (!asset) throw new Error('Newer release has no installer asset')
    updateDownloadUrl = asset.browser_download_url
    updateExpectedSha256 = asset.digest && asset.digest.toLowerCase().startsWith('sha256:') ? asset.digest.slice('sha256:'.length) : null
    updateState = { ...updateState, phase: 'available', latest, assetName: asset.name, assetSize: asset.size, error: null }
    logLine('update', `version ${latest} available (installed ${current})`)
    if (updatePrefs.autoDownload) {
      logLine('update', 'auto-download enabled — fetching in the background')
      void downloadUpdateAndOfferInstall()
      return publicUpdateState()
    }
    if (opts.announce && !updateDialogOpen) {
      updateDialogOpen = true
      dialog.showMessageBox({
        type: 'info',
        title: 'Opal Line Billing — Update available',
        message: `Version ${latest} is available.`,
        detail: `You have ${current}. The update will be downloaded and verified, then the app will restart to install it.`,
        buttons: ['Download & install', 'Later'],
        defaultId: 0,
        cancelId: 1,
      })
        .then((r) => { updateDialogOpen = false; if (r.response === 0) void downloadUpdateAndOfferInstall() })
        .catch(() => { updateDialogOpen = false })
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    updateState = { ...updateState, phase: 'error', error: message }
    logLine('update', `check failed: ${message}`)
  }
  return publicUpdateState()
}

async function downloadUpdateAndOfferInstall(): Promise<UpdateState & { current: string }> {
  if (!updateDownloadUrl || !updateState.latest || !updateState.assetName) return publicUpdateState()
  if (updateState.phase === 'downloading' || updateState.phase === 'ready') return publicUpdateState()
  const dest = join(app.getPath('temp'), `OpalLine-Setup-${updateState.latest}.exe`)
  updateState = { ...updateState, phase: 'downloading', progress: 0, error: null }
  logLine('update', `downloading ${updateState.assetName}…`)
  try {
    await httpsDownload(updateDownloadUrl, dest, updateState.assetSize ?? 0, (pct) => {
      updateState = { ...updateState, progress: pct }
      if (pct % 25 === 0) logLine('update', `download ${pct}%`)
    })
    if (updateExpectedSha256) {
      const actual = sha256File(dest)
      if (actual !== updateExpectedSha256) throw new Error('Downloaded installer failed SHA-256 verification')
    }
    try {
      verifyInstallerSignature(dest)
    } catch {
      throw new Error('Downloaded installer failed signature verification')
    }
    updateState = { ...updateState, phase: 'ready', progress: 100, filePath: dest }
    logLine('update', `verified update ${updateState.latest} at ${dest}`)
    if (updatePrefs.autoInstall) {
      logLine('update', 'auto-install enabled — restarting to apply')
      installUpdateAndRestart()
      return publicUpdateState()
    }
    if (!updateDialogOpen) {
      updateDialogOpen = true
      dialog.showMessageBox({
        type: 'info',
        title: 'Update ready',
        message: `Version ${updateState.latest} is downloaded and verified.`,
        detail: 'The app will restart to finish the update.',
        buttons: ['Restart now', 'Later'],
        defaultId: 0,
        cancelId: 1,
      })
        .then((r) => { updateDialogOpen = false; if (r.response === 0) installUpdateAndRestart() })
        .catch(() => { updateDialogOpen = false })
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    updateState = { ...updateState, phase: 'error', error: message }
    logLine('update', `download failed: ${message}`)
    try { rmSync(dest, { force: true }) } catch { /* ignore */ }
  }
  return publicUpdateState()
}

function installUpdateAndRestart(): void {
  if (!updateState.filePath) return
  const setup = updateState.filePath
  logLine('update', `restarting into installer ${setup}`)
  // Spawned installers used to die silently: NSIS aborts when the quitting app
  // still holds its exe/image locks (seen live on the 1.0.2 → 1.0.3 cycle).
  // Wait for this process to actually disappear, then run /S with retries and
  // log every step back into app.log so zero-click cycles are observable.
  // -EncodedCommand avoids any quoting pitfalls in the embedded script.
  const appLog = join(LOG_DIR, 'app.log').replace(/'/g, "''")
  const failFile = updateFailureFile().replace(/'/g, "''")
  const setupEsc = setup.replace(/'/g, "''")
  const exePath = process.execPath.replace(/'/g, "''")
  const script = [
    `$ErrorActionPreference = 'SilentlyContinue'`,
    `$log = '${appLog}'`,
    `$exe = '${exePath}'`,
    `function Note($m) { try { Add-Content -LiteralPath $log -Value ("[" + (Get-Date).ToUniversalTime().ToString("o") + "] [installer] " + $m) } catch {} }`,
    `function Ver { try { return (Get-Item -LiteralPath $exe).VersionInfo.ProductVersion } catch { return 'unknown' } }`,
    `$failFile = '${failFile}'`,
    `Remove-Item -LiteralPath $failFile -Force -ErrorAction SilentlyContinue`,
    `Note 'waiting for the app to exit before starting the installer'`,
    `$before = Ver`,
    `$deadline = (Get-Date).AddSeconds(30)`,
    `while ((Get-Date) -lt $deadline) {`,
    `  if (-not (Get-Process -Name 'Opal Line Billing' -ErrorAction SilentlyContinue)) { break }`,
    `  Start-Sleep -Milliseconds 500`,
    `}`,
    `Note ('app exited (or the wait timed out) - installed version before install: ' + $before)`,
    `$dir = Split-Path -Parent $exe`,
    `$done = $false`,
    `for ($i = 1; $i -le 3 -and -not $done; $i++) {`,
    `  try {`,
    // Pin $INSTDIR to where this app actually runs. Without /D, NSIS falls back
    // to its compiled default or a stale registration and can drop a second copy
    // in Program Files while the real install stays on the old version (seen on
    // the 1.0.3 -> 1.0.4 cycle). NSIS wants /D last and unquoted, so build the raw
    // command line with ProcessStartInfo instead of Start-Process quoting it.
    `    $psi = New-Object System.Diagnostics.ProcessStartInfo`,
    `    $psi.FileName = '${setupEsc}'`,
    `    $psi.Arguments = '/S /D=' + $dir`,
    `    $psi.UseShellExecute = $false`,
    `    $psi.WindowStyle = 'Hidden'`,
    `    $proc = [System.Diagnostics.Process]::Start($psi)`,
    `    $proc.WaitForExit()`,
    `    Note ('attempt ' + $i + ' installer exit code: ' + $proc.ExitCode)`,
    `  } catch { Note ('attempt ' + $i + ' failed to start: ' + $_.Exception.Message) }`,
    `  Start-Sleep -Seconds 2`,
    `  $after = Ver`,
    `  if ($after -ne $before -and $after -ne 'unknown') { $done = $true; Note ('installed version is now ' + $after + ' - relaunching the app') }`,
    `  else { Note ('attempt ' + $i + ' left the version at ' + $after + ' (installer likely hit a lock or a foreign install) - retrying'); Start-Sleep -Seconds 3 }`,
    `}`,
    `if ($done) { Start-Process -FilePath $exe } else { Note 'could not apply the update automatically - run the downloaded installer manually'; $f = [ordered]@{ at = (Get-Date).ToUniversalTime().ToString('o'); reason = 'The update could not be installed automatically after 3 attempts. The app is still on the previous version.' } | ConvertTo-Json -Compress; try { Set-Content -LiteralPath $failFile -Value $f -Encoding UTF8 } catch {}; Start-Process -FilePath $exe }`,
  ].join('; ')
  // Detach cmd.exe, NOT powershell.exe: a detached powershell.exe child never
  // actually starts in this environment (verified — it exits without running a
  // single line), so the whole handoff silently died. A detached cmd.exe both
  // survives app.quit() and, in turn, runs this PowerShell as a foreground
  // child that always executes. Base64 has no spaces/quotes, so /c needs no quoting.
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  const child = spawn('cmd.exe', ['/c', 'powershell.exe', '-NoProfile', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
  app.quit()
}

ipcMain.handle('updates:check', () => checkForUpdates({ announce: false }))
ipcMain.handle('updates:download', () => downloadUpdateAndOfferInstall())
ipcMain.handle('updates:install', () => {
  if (updateState.phase === 'ready') {
    installUpdateAndRestart()
    return true
  }
  return false
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) { createWindow(); loadAppInWindow() } })

/**
 * Release the ports this instance holds.
 *
 * `backendProcess.kill()` alone was the bug: in dev the backend runs under
 * `shell: true`, so it only killed the shell and left the node child holding
 * the port. `killTree` takes the process group down with it, and the
 * listener pid is used first when it is available because that is the
 * process that actually owns the socket.
 */
function shutdownResources(): void {
  const recorded = recordedBackendPid()
  if (recorded !== null) {
    killTree(recorded)
    clearBackendPid()
  }
  if (backendProcess) {
    const pid = backendProcess.pid
    backendProcess.kill()
    if (pid) killTree(pid)
    backendProcess = null
  }
  stopPostgres()
}

app.on('before-quit', shutdownResources)

// Safety net: `before-quit` does not run when the process is terminated
// directly (SIGINT/SIGTERM, an uncaught exception, or the parent dying).
// Without this the backend and postgres outlive the app, which is why the
// ports stayed taken after closing it.
process.on('SIGINT', () => { shutdownResources(); process.exit(130) })
process.on('SIGTERM', () => { shutdownResources(); process.exit(143) })
process.on('uncaughtException', (err) => {
  console.error('[electron] uncaughtException:', err)
  logLine('electron', 'uncaughtException: ' + String(err?.stack ?? err))
  shutdownResources()
  process.exit(1)
})

async function main() {
  try {
    ensureDirs()
    if (!preflightPorts()) {
      app.quit()
      return
    }
    // Show the splash window immediately — the Postgres + backend startup
    // below can take several seconds, during which the user otherwise sees
    // nothing at all after clicking the icon.
    await app.whenReady()
    createWindow()
    console.log('[electron] Ensuring PostgreSQL…')
    const managedUrl = await ensurePostgres()
    const { path: envPath, isFirstRun } = ensureEnvFile(managedUrl)
    console.log('[electron] Starting backend server…')
    await startBackend(envPath, managedUrl || null)
    console.log('[electron] Backend started, loading app…')
    loadAppInWindow()
    // Auto-update: first check shortly after launch, then every 6 hours.
    if (app.isPackaged) {
      loadUpdatePrefs()
      // Remove installers left behind by past update cycles before anything
      // else touches the temp folder (see electron/updatesweep.ts).
      try {
        sweepDownloads(app.getPath('temp'), app.getVersion()).forEach(
          (name) => logLine('update', `swept stale download ${name}`),
        )
      } catch { /* best effort — temp cleanup must never block startup */ }
      // Tell the user straight away if the last automatic install gave up.
      const failure = readUpdateFailure()
      if (failure) {
        logLine('update', `showing failed-update notice from ${failure.at || 'an earlier run'}`)
        setTimeout(() => {
          dialog.showMessageBox({
            type: 'warning',
            title: 'Update not installed',
            message: `The app is still on version ${app.getVersion()}.`,
            detail: `${failure.reason}\n\nOpen System \u2192 App Updates to retry, or run the downloaded installer manually.`,
            buttons: ['OK'],
            defaultId: 0,
          })
            .catch(() => undefined)
        }, 8000)
      }
      setTimeout(() => { void checkForUpdates({ announce: true }) }, 60 * 1000)
      setInterval(() => { void checkForUpdates({ announce: true }) }, UPDATE_CHECK_INTERVAL_MS)
    }
    // On first run, show credentials dialog after a short delay
    if (isFirstRun) {
      setTimeout(() => {
        // The backend writes the generated admin password here; show that real
        // credential once, then delete the file. Never fall back to a hardcoded
        // password — that is what made every install share a public credential.
        const credFile = join(DATA_DIR, 'first-run-credentials.json')
        let detail = 'The admin account was created. Sign in with the username "admin".'
        let credTxtPath: string | undefined
        try {
          const creds = JSON.parse(readFileSync(credFile, 'utf8')) as { username?: string; password?: string }
          if (creds.password) {
            const username = creds.username ?? 'admin'
            detail = `Username: ${username}\nPassword: ${creds.password}\n\nThis is the built-in superadmin account. On the first sign-in the app asks you to set a new password — that is expected. Save these somewhere safe.`
            // Persist a plain-text copy the user can open and copy from at any
            // time. Written BEFORE the dialog: headless sessions may never show
            // the dialog, so this file — not the dialog — is the durable copy.
            try {
              credTxtPath = join(APP_DATA, 'Opal-First-Run-Credentials.txt')
              writeFileSync(credTxtPath, `Opal Line Billing - first-run credentials\r\n==============================================\r\n\r\nUsername:  ${username}\r\nPassword:  ${creds.password}\r\n\r\nThis is the built-in superadmin account. On the first sign-in the app\r\nasks you to set a new password — that is expected.\r\n\r\nThis file is written once, on first install. Move it somewhere safe\r\n(or delete it) after saving the password in a password manager.\r\n`)
            } catch { /* best effort */ }
          }
        } catch { /* no credentials file (existing install) */ }
        dialog.showMessageBox({
          type: 'info',
          title: 'Opal Line Billing — First Run',
          message: 'Admin account created!',
          detail,
          buttons: ['OK'],
        }).finally(() => {
          try { rmSync(credFile, { force: true }) } catch { /* best effort */ }
          // Open the persisted credentials file so the password stays easy to
          // copy even if this dialog was dismissed too fast.
          if (credTxtPath) {
            shell.openPath(credTxtPath).catch(() => undefined)
          }
        })
      }, 3000)
    }
  } catch (err) {
    console.error('[electron] Failed to start:', err)
    logLine('electron', 'startup failed: ' + String((err as Error)?.message ?? err))
    dialog.showErrorBox('Startup failed', String((err as Error)?.message ?? err))
    // Leave the user on the real UI (which shows its own connection error)
    // rather than a splash that never finishes.
    if (mainWindow) loadAppInWindow()
    else createWindow()
  }
}

// One instance at a time. Without this a second launch raced the first for
// the same fixed ports and produced the "port already in use" dialog, then
// left the user unsure which window (if any) was live. The lock dies with the
// process, so it only covers a *live* instance — an orphaned backend with no
// Electron process is a different case, handled in preflightPorts().
const gotSingleInstanceLock = app.requestSingleInstanceLock()

if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    // A second launch happened — surface the running window instead of
    // fighting it for the port.
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })
  main()
}
