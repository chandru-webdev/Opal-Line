// Unattended end-to-end test of the DESKTOP AUTO-UPDATE CHAIN against the
// INSTALLED app (packaged build — the updater refuses to run in dev).
//
// How it works (no code changes to the shipped app):
//   1. Generates a throwaway CA + a server certificate for 127.0.0.1.
//   2. Serves a local HTTPS mock of the GitHub latest-release API. The
//      "newer" installer asset is a real, Authenticode-signed Setup exe, so
//      the app's SHA-256 and signature verification pass exactly as they
//      would against a real release.
//   3. Same-length-patches the single update-feed URL anchor inside the
//      installed app.asar (29 bytes -> 29 bytes, archive offsets stay
//      valid), then relaunches the app with NODE_EXTRA_CA_CERTS pointing at
//      the throwaway CA. Trust is env-gated: without the env var the patch
//      is inert (the local feed fails TLS validation).
//   4. Stages assertions against app.log:
//        available -> download -> SHA-256+Authenticode verified ->
//        detached installer handoff -> (reject) version-compare detects the
//        unchanged version, retries, writes the failure marker, relaunch,
//        failed-update notice  |  (happy) version changed, relaunch.
//   5. Restores everything: asar, update prefs, %TEMP% download, failure
//      marker, kill the app. --keep skips the restore for debugging.
//
// Usage:
//   node scripts/update-flow-test.mjs [--expect reject|happy] [--installer <path>]
//                                     [--fake-version X.Y.Z] [--port N] [--keep]
//
// Default: --expect reject with the newest dist-electron Setup exe served as
// fake version (installed+1) — the installer cannot change the ProductVersion
// it was built with, so the handoff correctly ends in the retry/failure
// branch. Pass --expect happy --installer <genuinely newer signed build> to
// assert the success branch instead.
import { execFileSync, spawn } from 'node:child_process'
import {
  copyFileSync, createReadStream, existsSync, mkdtempSync, readdirSync, readFileSync,
  rmSync, statSync, writeFileSync, openSync, closeSync, readSync, writeSync,
} from 'node:fs'
import { createServer } from 'node:https'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// ── pure helpers (unit-tested in scripts/update-flow-harness.test.mjs) ─────

/** The literal baked into the packed main bundle (fetchLatestRelease). */
export const FEED_ANCHOR = 'https://api.github.com/repos/'

/** Same-length replacement for the anchor that targets a local feed. */
export function feedUrlForPort(port, anchorLen = Buffer.byteLength(FEED_ANCHOR)) {
  const base = `https://127.0.0.1:${port}/`
  if (base.length > anchorLen) throw new Error(`port too long for anchor: ${base.length} > ${anchorLen}`)
  return base + '/'.repeat(anchorLen - base.length)
}

/** Patch a same-length anchor occurrence. Returns info; never mutates input. */
export function patchAsarAnchor(buf, replacement = FEED_ANCHOR) {
  const anchor = Buffer.from(FEED_ANCHOR, 'utf8')
  const occurrences = buf.indexOf(anchor) === -1 ? 0 : countOccurrences(buf, anchor)
  if (occurrences !== 1 || replacement === FEED_ANCHOR) return { occurrences, patched: false, out: buf }
  const rep = Buffer.from(replacement, 'utf8')
  if (rep.length !== anchor.length) throw new Error(`replacement length ${rep.length} != ${anchor.length}`)
  const out = Buffer.from(buf)
  const at = out.indexOf(anchor)
  rep.copy(out, at)
  return { occurrences, patched: true, out }
}

function countOccurrences(buf, needle) {
  let n = 0, i = buf.indexOf(needle)
  while (i !== -1) { n++; i = buf.indexOf(needle, i + needle.length) }
  return n
}

export function bumpPatchVersion(v) {
  const parts = String(v).replace(/^v/, '').split('.').map((p) => parseInt(p, 10) || 0)
  while (parts.length < 3) parts.push(0)
  parts[2] += 1
  return parts.slice(0, 3).join('.')
}

export function isNewerVersionStr(current, latest) {
  const pa = String(current).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0)
  const pb = String(latest).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) {
    const diff = (pb[i] ?? 0) - (pa[i] ?? 0)
    if (diff !== 0) return diff > 0
  }
  return false
}

export function buildFeedManifest({ version, port, size, sha256, assetName }) {
  return {
    tag_name: `v${version}`,
    assets: [
      {
        name: assetName ?? `Opal.Line.Billing-Setup-${version}.exe`,
        browser_download_url: `https://127.0.0.1:${port}/installer.exe`,
        size,
        digest: `sha256:${sha256}`,
      },
    ],
  }
}

// ── harness ────────────────────────────────────────────────────────────────

const APP_NAME = 'Opal Line Billing'
const results = []
let failures = 0
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`)
  if (!ok) failures++
}

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag)
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts })
}

function ps(script) {
  return sh('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]).trim()
}

function sha256File(p) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    const s = createReadStream(p)
    s.on('data', (c) => h.update(c))
    s.on('end', () => resolve(h.digest('hex')))
    s.on('error', reject)
  })
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

async function waitForLogLine(logPath, fromOffset, stages, onAbort) {
  // stages: [{ name, pattern, deadlineMs }] consumed in order. Returns the
  // first stage index that timed out, or -1 when all matched.
  let offset = fromOffset
  let pending = ''
  let stageIdx = 0
  const stageStart = Date.now()
  while (stageIdx < stages.length) {
    if (existsSync(logPath)) {
      const fd = openSync(logPath, 'r')
      try {
        const size = statSync(logPath).size
        if (size > offset) {
          const buf = Buffer.alloc(size - offset)
          readSync(fd, buf, 0, buf.length, offset)
          offset = size
          pending += buf.toString('utf8')
        }
      } finally { closeSync(fd) }
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) {
        console.log(`  | ${line.slice(0, 160)}`)
        if (onAbort && onAbort(line)) return { aborted: line, stageIdx }
        if (stages[stageIdx] && stages[stageIdx].pattern.test(line)) {
          console.log(`  > stage matched: ${stages[stageIdx].name}`)
          stageIdx++
          // continue scanning buffered lines for the next stage
        }
      }
    }
    if (stageIdx >= stages.length) break
    if (Date.now() - stageStart > stages[stageIdx].deadlineMs) {
      return { timedOutAt: stages[stageIdx].name, stageIdx }
    }
    await sleep(2000)
  }
  return { stageIdx }
}

async function main() {
  const expect = arg('--expect', 'reject')
  const keep = process.argv.includes('--keep')
  const port = parseInt(arg('--port', '47991'), 10)
  if (expect !== 'reject' && expect !== 'happy') {
    console.error('--expect must be reject or happy'); process.exit(2)
  }

  const localAppData = process.env.LOCALAPPDATA
  const roamAppData = process.env.APPDATA
  if (!localAppData || !roamAppData) { console.error('LOCALAPPDATA/APPDATA not set'); process.exit(2) }
  const installDir = join(localAppData, 'Programs', APP_NAME)
  const appExe = join(installDir, `${APP_NAME}.exe`)
  const asarPath = join(installDir, 'resources', 'app.asar')
  const prefsFile = join(roamAppData, APP_NAME, 'data', 'update-prefs.json')
  const logPath = join(roamAppData, APP_NAME, 'logs', 'app.log')
  const appTemp = process.env.TEMP || process.env.TMP || tmpdir()

  for (const [label, p] of [['installed app', appExe], ['app.asar', asarPath]]) {
    if (!existsSync(p)) { console.error(`${label} not found: ${p}\nInstall the app (scripts/smoke-test-install.ps1) before running this test.`); process.exit(2) }
  }
  try { sh('openssl.exe', ['version']) } catch {
    try { sh('openssl', ['version']) } catch {
      console.error('openssl not found on PATH (needed to mint the throwaway feed CA)'); process.exit(2)
    }
  }
  const openssl = (() => { try { sh('openssl.exe', ['version']); return 'openssl.exe' } catch { return 'openssl' } })()
  const opensslEnv = { ...process.env, MSYS_NO_PATHCONV: '1' }

  // Payload + installed version
  let installer = arg('--installer', '')
  if (!installer) {
    const dir = join(process.cwd(), 'dist-electron')
    const candidates = existsSync(dir)
      ? readdirSync(dir).filter((f) => /-Setup-.*\.exe$/i.test(f)).map((f) => join(dir, f))
      : []
    if (candidates.length === 0) { console.error('no --installer given and no dist-electron/*Setup-*.exe found'); process.exit(2) }
    installer = candidates.sort().at(-1)
  }
  if (!existsSync(installer)) { console.error(`installer not found: ${installer}`); process.exit(2) }

  const installed = ps(`(Get-Item -LiteralPath '${appExe}').VersionInfo.ProductVersion`).split('.').slice(0, 3).join('.')
  const fake = arg('--fake-version', bumpPatchVersion(installed))
  if (!isNewerVersionStr(installed, fake)) { console.error(`advertised version ${fake} is not newer than installed ${installed}`); process.exit(2) }
  if (expect === 'happy' && fake === bumpPatchVersion(installed)) {
    console.error('happy path needs a genuinely newer signed build: pass --installer <newer setup> --fake-version <its version>')
    process.exit(2)
  }

  console.log(`installed=${installed}  fake=${fake}  expect=${expect}`)
  console.log(`payload=${installer}`)

  const work = mkdtempSync(join(tmpdir(), 'update-flow-'))
  const asarBackup = join(work, 'app.asar.bak')
  const prefsBackup = join(work, 'update-prefs.json.bak')
  const payloadCopy = join(work, 'installer.exe')
  const caPath = join(work, 'ca.pem')
  let server = null
  let appProc = null
  let asarPatched = false
  let prefsFlipped = false

  const stopApp = () => {
    // Best effort on both: a process that is not running, or one left behind
    // by an elevated session (access denied), must never abort the test — the
    // app brings up its own postgres on the free port at relaunch.
    try { ps(`Stop-Process -Name '${APP_NAME}' -Force -ErrorAction SilentlyContinue`) } catch { /* not running */ }
    try { ps(`Stop-Process -Name postgres -Force -ErrorAction SilentlyContinue`) } catch { /* elevated leftover */ }
  }
  const stopAppQuiet = () => { try { stopApp() } catch { /* already gone */ } }

  try {
    // 1. CA + server cert
    sh(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(work, 'ca.key'), '-out', caPath, '-days', '2', '-subj', '/CN=Opal Update Flow Test CA'], { env: opensslEnv })
    sh(openssl, ['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(work, 'srv.key'), '-out', join(work, 'srv.csr'), '-subj', '/CN=127.0.0.1'], { env: opensslEnv })
    writeFileSync(join(work, 'ext.cnf'), 'subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n')
    sh(openssl, ['x509', '-req', '-in', join(work, 'srv.csr'), '-CA', caPath, '-CAkey', join(work, 'ca.key'), '-CAcreateserial', '-out', join(work, 'srv.pem'), '-days', '2', '-extfile', join(work, 'ext.cnf')], { env: opensslEnv })
    check('throwaway feed CA + 127.0.0.1 server cert minted', true)

    // 2. Payload + manifest
    copyFileSync(installer, payloadCopy)
    const size = statSync(payloadCopy).size
    const sha = await sha256File(payloadCopy)
    const manifest = buildFeedManifest({ version: fake, port, size, sha256: sha })
    check('payload staged + digest computed', size > 0 && /^sha256:[0-9a-f]{64}$/.test(manifest.assets[0].digest), `${(size / 1048576).toFixed(1)} MB`)

    // 3. Local HTTPS feed
    server = createServer(
      { key: readFileSync(join(work, 'srv.key')), cert: readFileSync(join(work, 'srv.pem')) },
      (req, res) => {
        const url = req.url ?? ''
        if (url.split('?')[0].endsWith('/installer.exe')) {
          res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(size) })
          createReadStream(payloadCopy).pipe(res)
          return
        }
        if (url.includes('releases/latest')) {
          const body = JSON.stringify(manifest)
          res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) })
          res.end(body)
          return
        }
        res.writeHead(200); res.end('feed ok')
      },
    )
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', resolve)
    })
    check(`local release feed listening on 127.0.0.1:${port}`, true)

    // 4. Stop the app, patch the asar, flip prefs
    stopApp()
    await sleep(1500)
    copyFileSync(asarPath, asarBackup)
    const { occurrences, patched, out } = patchAsarAnchor(readFileSync(asarPath), feedUrlForPort(port))
    if (occurrences !== 1) throw new Error(`expected exactly 1 feed anchor in app.asar, found ${occurrences}`)
    writeFileSync(asarPath, out)
    asarPatched = patched
    check('app.asar feed anchor patched (same length)', patched, `size ${statSync(asarPath).size}`)

    if (existsSync(prefsFile)) copyFileSync(prefsFile, prefsBackup)
    writeFileSync(prefsFile, JSON.stringify({ autoDownload: true, autoInstall: true, showBanner: true }))
    prefsFlipped = true
    check('update prefs flipped to autoDownload+autoInstall (backed up)', true)

    // 5. Relaunch the app trusting only the throwaway CA; watch app.log
    const logOffset = existsSync(logPath) ? statSync(logPath).size : 0
    appProc = spawn(appExe, [], { detached: true, stdio: 'ignore', windowsHide: false, env: { ...process.env, NODE_EXTRA_CA_CERTS: caPath } })
    appProc.unref()
    check('app relaunched with env-gated feed trust', true)

    const stages = [
      { name: 'update available', pattern: new RegExp(`version ${fake.replace(/\./g, '\\.')} available`), deadlineMs: 150_000 },
      { name: 'download + verification', pattern: new RegExp(`verified update ${fake.replace(/\./g, '\\.')}`), deadlineMs: 240_000 },
      { name: 'installer handoff', pattern: /\[installer\] waiting for the app to exit/, deadlineMs: 120_000 },
    ]
    if (expect === 'reject') {
      stages.push(
        { name: 'version-compare failure detected', pattern: /could not apply the update automatically/, deadlineMs: 420_000 },
        // The relaunch lands seconds after three silent NSIS re-extracts of
        // the install dir; antivirus real-time scanning of the fresh files
        // can stall or even kill that boot (seen live: hard-terminated mid
        // pg_ctl wait, no crash event). 300s gives the scan storm room; the
        // assertion itself is unchanged — the notice line must still appear.
        { name: 'failed-update notice shown on relaunch', pattern: /showing failed-update notice/, deadlineMs: 300_000 },
      )
    } else {
      stages.push({ name: 'new version installed', pattern: new RegExp(`installed version is now ${fake.replace(/\./g, '\\.')}`), deadlineMs: 420_000 })
    }

    const outcome = await waitForLogLine(logPath, logOffset, stages, (line) =>
      /\[update\] (check failed|download failed)/.test(line))
    if (outcome.aborted) throw new Error(`updater reported an error: ${outcome.aborted.trim().slice(0, 160)}`)
    if (outcome.timedOutAt) throw new Error(`timed out waiting for stage: ${outcome.timedOutAt}`)
    check(`stage chain (${expect} branch)`, true, stages.map((s) => s.name).join(' -> '))

    // 6. Branch-specific end state
    stopAppQuiet()
    if (expect === 'reject') {
      const download = join(appTemp, `OpalLine-Setup-${fake}.exe`)
      check('newer download left in %TEMP% (pending update survives sweep)', existsSync(download))
      const marker = join(roamAppData, APP_NAME, 'data', 'update-failure.json')
      check('failure marker written for the Updates page', existsSync(marker))
      check('installed version unchanged after same-version install', ps(`(Get-Item -LiteralPath '${appExe}').VersionInfo.ProductVersion`).startsWith(installed))
    } else {
      const nowVer = ps(`(Get-Item -LiteralPath '${appExe}').VersionInfo.ProductVersion`).split('.').slice(0, 3).join('.')
      check('installed version advanced to the fake release', nowVer === fake, `now ${nowVer}`)
    }
  } finally {
    stopAppQuiet()
    if (server) await new Promise((r) => server.close(r)).catch(() => undefined)

    // Restore the asar only if the patch survived (the NSIS reinstall in the
    // reject branch rewrites it with pristine bytes automatically; the happy
    // branch installs a genuinely new build whose asar we must NOT roll back).
    try {
      if (asarPatched && existsSync(asarPath)) {
        const cur = readFileSync(asarPath)
        if (patchAsarAnchor(cur).patched) {
          if (!keep) { copyFileSync(asarBackup, asarPath); console.log('restored app.asar from backup') }
          else console.log('--keep: left the patched asar in place')
        } else console.log('app.asar already pristine (rewritten by the installer)')
      }
      if (prefsFlipped && existsSync(prefsBackup)) {
        if (!keep) copyFileSync(prefsBackup, prefsFile); console.log(keep ? '--keep: left flipped prefs' : 'restored update-prefs.json')
      }
      if (!keep) {
        // The detached installer can outlive the harness (it is spawned by
        // the app's own update helper). Deleting its download mid-extract
        // would kill a healthy install in progress — wait it out, bounded.
        const setupAlive = () => {
          try { return ps(`(Get-Process -Name '${APP_NAME.replace(/ /g, '.')}-Setup-*' -ErrorAction SilentlyContinue).Count`) !== '0' } catch { return false }
        }
        for (let i = 0; i < 45 && setupAlive(); i++) await sleep(2000)
        if (setupAlive()) {
          console.log(`left ${`OpalLine-Setup-${fake}.exe`} in %TEMP%: a setup process is still running`)
        } else {
          rmSync(join(appTemp, `OpalLine-Setup-${fake}.exe`), { force: true })
        }
        rmSync(join(roamAppData, APP_NAME, 'data', 'update-failure.json'), { force: true })
      }
    } catch (e) { console.error('cleanup warning:', e.message) }
    if (!keep) rmSync(work, { recursive: true, force: true })
    else console.log(`--keep: work dir ${work} retained`)
  }

  console.log('')
  if (failures === 0) { console.log(`UPDATE FLOW TEST PASSED (${expect} branch)`); process.exit(0) }
  console.log(`UPDATE FLOW TEST FAILED - ${failures} check(s) failed`)
  process.exit(1)
}

// Only run when executed directly; unit tests import the pure helpers above.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`UPDATE FLOW TEST FAILED - ${e.message}`)
    process.exit(1)
  })
}
