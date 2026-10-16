// Proves electron/updatesweep.ts keeps %TEMP% from accumulating dead update
// installers. The auto-updater downloads each new version as
// OpalLine-Setup-<ver>.exe into the OS temp folder; nothing removed them
// (2.1 GB had piled up across the 1.0.3 → 1.0.18 cycles).
//
//   1. Installers for the running version and older are removed.
//   2. A download for a NEWER version is a pending update and is kept.
//   3. Any other file — including look-alike installer names — is untouched.
//   4. Suffix versions (1.2.0-rc.1) follow isNewerVersion.
//   5. An unreadable directory throws — the caller decides to swallow it.
//
// The module is TypeScript, so compile electron/ with tsc first (the same
// command scripts/build-desktop.js runs) and import the emitted JS.
//
// Run: node --test scripts/update-sweep.test.mjs
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

execSync('npx tsc', { cwd: join(repoRoot, 'electron'), stdio: 'pipe', timeout: 120000 })
const { sweepDownloads, isNewerVersion } = await import(
  pathToFileURL(join(repoRoot, 'electron', 'dist', 'updatesweep.js')).href
)

const dir = mkdtempSync(join(tmpdir(), 'opal-upsweep-'))

/** Reset the fixture dir to exactly these files. */
function seed(...names) {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  for (const n of names) writeFileSync(join(dir, n), 'installer-bytes')
}

after(() => rmSync(dir, { recursive: true, force: true }))

test('isNewerVersion semantics used by the sweep', () => {
  assert.equal(isNewerVersion('1.0.20', '1.0.21'), true)
  assert.equal(isNewerVersion('1.0.20', '1.0.20'), false)
  assert.equal(isNewerVersion('1.0.20', '1.0.19'), false)
  assert.equal(isNewerVersion('1.0.20', '1.1.0'), true)
  assert.equal(isNewerVersion('1.0.20', '2.0.0'), true)
})

test('installers for the running version and older are removed', () => {
  seed('OpalLine-Setup-1.0.3.exe', 'OpalLine-Setup-1.0.18.exe', 'OpalLine-Setup-1.0.20.exe')
  const swept = sweepDownloads(dir, '1.0.20').sort()
  assert.deepEqual(swept, [
    'OpalLine-Setup-1.0.3.exe',
    'OpalLine-Setup-1.0.18.exe',
    'OpalLine-Setup-1.0.20.exe',
  ].sort())
  for (const n of swept) {
    assert.equal(existsSync(join(dir, n)), false, `${n} must be gone`)
  }
})

test('a download for a newer version is a pending update and is kept', () => {
  seed('OpalLine-Setup-1.0.21.exe')
  assert.deepEqual(sweepDownloads(dir, '1.0.20'), [])
  assert.ok(existsSync(join(dir, 'OpalLine-Setup-1.0.21.exe')), 'pending update must survive')
})

test('non-matching names are never touched', () => {
  seed(
    'Opal.Line.Billing-Setup-1.0.7.exe', // manual download, different name
    'installer.exe',                       // unrelated
    'OpalLine-Setup-latest.exe',           // not a plain x.y.z version
    'OpalLine-Setup-1.0.19.exe.bak',       // does not end in .exe after a version
    'unrelated-1.0.1.exe',                 // different prefix
  )
  const swept = sweepDownloads(dir, '1.0.20')
  assert.deepEqual(swept, [], 'nothing matched the update-download pattern')
  for (const n of [
    'Opal.Line.Billing-Setup-1.0.7.exe',
    'installer.exe',
    'OpalLine-Setup-latest.exe',
    'OpalLine-Setup-1.0.19.exe.bak',
    'unrelated-1.0.1.exe',
  ]) {
    assert.ok(existsSync(join(dir, n)), `${n} must be untouched`)
  }
})

test('suffix versions are judged by isNewerVersion', () => {
  seed('OpalLine-Setup-1.2.0-rc.1.exe', 'OpalLine-Setup-1.0.20-hotfix.exe')
  const swept = sweepDownloads(dir, '1.0.20')
  // equal-version suffix is stale (swept); a greater version is pending (kept)
  assert.deepEqual(swept, ['OpalLine-Setup-1.0.20-hotfix.exe'])
  assert.ok(existsSync(join(dir, 'OpalLine-Setup-1.2.0-rc.1.exe')))
})

test('an unreadable directory throws — the caller decides to swallow it', () => {
  assert.throws(() => sweepDownloads(join(dir, 'never-existed'), '1.0.20'))
})
