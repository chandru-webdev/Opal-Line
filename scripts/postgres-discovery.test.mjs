// Regression tests for electron/postgres.ts — the desktop app's PostgreSQL
// binary discovery and major-version matching.
//
// These cover the "PostgreSQL could not start after 3 attempts" failure: the
// app bundled PostgreSQL 16.4 and preferred it unconditionally, so it fed a
// PostgreSQL 18 data directory to PG 16 binaries. PG 16 rejects the PG 18-only
// `autovacuum_worker_slots` GUC with
//   FATAL: unrecognized configuration parameter "autovacuum_worker_slots"
// and the server never starts. Discovery must find PG 18 and the selector must
// match the cluster's PG_VERSION exactly.
//
// The module is TypeScript, so compile electron/ with tsc first (the same
// command scripts/build-desktop.js and test:desktop run) and import the
// emitted JS.
//
// Run: node --test scripts/postgres-discovery.test.mjs
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

execSync('npx tsc', { cwd: join(repoRoot, 'electron'), stdio: 'pipe', timeout: 120000 })
const {
  PG_SUPPORTED_MAJORS, parseMajor, dataDirMajor, systemPostgresBinDirs,
  selectPostgres, logDiagnostics, pgTool, hasPgCtl,
} = await import(pathToFileURL(join(repoRoot, 'electron', 'dist', 'postgres.js')).href)

test('supported majors include PostgreSQL 18 and every 15+ release', () => {
  for (const m of [15, 16, 17, 18]) assert.ok(PG_SUPPORTED_MAJORS.includes(m), `PG ${m}`)
  assert.equal(Math.min(...PG_SUPPORTED_MAJORS), 15, 'documented 15+ floor')
})

test('parseMajor reads the version from pg_ctl/psql output', () => {
  assert.equal(parseMajor('pg_ctl (PostgreSQL) 18.4'), 18)
  assert.equal(parseMajor('postgres (PostgreSQL) 17.2'), 17)
  assert.equal(parseMajor('psql (PostgreSQL) 15.6'), 15)
  assert.equal(parseMajor('not a version'), null)
  assert.equal(parseMajor(''), null)
  assert.equal(parseMajor(undefined), null)
})

test('dataDirMajor reads a cluster PG_VERSION', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opal-pgmajor-'))
  try {
    assert.equal(dataDirMajor(dir), null, 'no cluster yet')
    writeFileSync(join(dir, 'PG_VERSION'), '18\n')
    assert.equal(dataDirMajor(dir), 18)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('systemPostgresBinDirs scans Program Files and finds 18 newest-first', () => {
  const root = mkdtempSync(join(tmpdir(), 'opal-pgsys-'))
  try {
    for (const v of ['18', '17', '16']) {
      mkdirSync(join(root, 'PostgreSQL', v, 'bin'), { recursive: true })
      writeFileSync(join(root, 'PostgreSQL', v, 'bin', 'pg_ctl.exe'), '')
    }
    // A version folder without pg_ctl is not a usable install.
    mkdirSync(join(root, 'PostgreSQL', '15', 'bin'), { recursive: true })

    const dirs = systemPostgresBinDirs(root)
    assert.deepEqual(dirs.map((d) => d.major), [18, 17, 16])
    assert.equal(dirs[0].bin, join(root, 'PostgreSQL', '18', 'bin'))
    assert.equal(hasPgCtl(dirs[0].bin), true)
    assert.equal(pgTool(dirs[0].bin, 'pg_ctl'), join(dirs[0].bin, 'pg_ctl.exe'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('selectPostgres picks the cluster-matching major, never a mismatch', () => {
  const bundled16 = { source: 'bundled', bin: 'bundled-16', major: 16 }
  const system18 = { source: 'system', bin: 'system-18', major: 18 }
  const system17 = { source: 'system', bin: 'system-17', major: 17 }

  // PG 18 cluster: the bundled 16 must be skipped for the matching system 18.
  const for18 = selectPostgres(18, [bundled16, system17, system18])
  assert.equal(for18.bin, 'system-18')
  assert.equal(for18.major, 18)
  assert.equal(for18.source, 'system')

  // PG 16 cluster: bundled 16 wins over the newer system installs.
  const for16 = selectPostgres(16, [bundled16, system17, system18])
  assert.equal(for16.bin, 'bundled-16')

  // PG 18 cluster but only 16/17 available: refuse with a version-specific error.
  const mismatch = selectPostgres(18, [bundled16, system17])
  assert.ok('error' in mismatch, 'must not start a mismatched binary')
  assert.match(mismatch.error, /PostgreSQL 18/)
  assert.match(mismatch.error, /PostgreSQL 17, PostgreSQL 16|PostgreSQL 16, PostgreSQL 17/)

  // Fresh install (no cluster): bundled preferred.
  const fresh = selectPostgres(null, [bundled16, system18])
  assert.equal(fresh.bin, 'bundled-16')
  // Fresh install without a bundled build: newest system major.
  const freshSys = selectPostgres(null, [system17, system18])
  assert.equal(freshSys.bin, 'system-18')

  // Nothing usable at all.
  assert.match(selectPostgres(18, []).error, /no PostgreSQL 18 binaries were found/i)
  assert.match(selectPostgres(null, []).error, /No PostgreSQL binaries were found/)
})

test('selectPostgres ignores candidates whose major could not be read', () => {
  const unknown = { source: 'system', bin: 'unknown', major: null }
  const system18 = { source: 'system', bin: 'system-18', major: 18 }
  assert.equal(selectPostgres(18, [unknown, system18]).bin, 'system-18')
  assert.match(selectPostgres(18, [unknown]).error, /PostgreSQL 18/)
})

test('logDiagnostics reports the real FATAL and falls back to the tail', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opal-pglog-'))
  try {
    assert.equal(logDiagnostics(join(dir, 'missing.log')), '')

    const fatalLog = join(dir, 'postgres.log')
    writeFileSync(fatalLog, [
      'LOG:  starting PostgreSQL 16.4',
      'LOG:  could not receive data from client',
      'FATAL:  unrecognized configuration parameter "autovacuum_worker_slots"',
      'LOG:  database system is shut down',
    ].join('\n'))
    const diag = logDiagnostics(fatalLog)
    assert.match(diag, /FATAL: {2}unrecognized configuration parameter/)
    assert.ok(!diag.includes('could not receive data'), 'FATAL lines win over noise')

    // No FATAL/ERROR: fall back to the last lines rather than nothing.
    const quiet = join(dir, 'quiet.log')
    writeFileSync(quiet, ['one', 'two', 'three'].join('\n'))
    assert.equal(logDiagnostics(quiet), 'one\ntwo\nthree')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

after(() => { /* temp dirs are removed inside each test */ })
