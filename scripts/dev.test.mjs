import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { envFileValue, upsertEnvValue, parseDbUrl, appDataDir } from './dev.mjs'

// Pure-helper tests for the `npm run dev` bootstrap. No database, no network:
// provisioning itself is exercised live by running `npm run dev`.

test('parseDbUrl extracts host and port from postgres URLs', () => {
  assert.deepEqual(parseDbUrl('postgresql://postgres:pw@127.0.0.1:47193/opal_line'), { host: '127.0.0.1', port: 47193 })
  assert.deepEqual(parseDbUrl('postgres://user@db.example.com/opal'), { host: 'db.example.com', port: 5432 })
  assert.deepEqual(parseDbUrl('postgresql://[::1]:5433/x'), { host: '::1', port: 5433 })
  assert.equal(parseDbUrl('not a url'), null)
})

test('envFileValue reads KEY=value and tolerates missing files/comments', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opal-dev-test-'))
  try {
    const file = join(dir, '.env')
    assert.equal(envFileValue(file, 'DATABASE_URL'), '', 'missing file → empty')
    writeFileSync(file, '# comment\nPORT=47191\nDATABASE_URL=postgresql://x\n')
    assert.equal(envFileValue(file, 'DATABASE_URL'), 'postgresql://x')
    assert.equal(envFileValue(file, 'PORT'), '47191')
    assert.equal(envFileValue(file, 'NOPE'), '')
    assert.equal(envFileValue(file, 'comment'), '', 'commented lines are not values')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('upsertEnvValue adds and replaces without disturbing the rest of the file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opal-dev-test-'))
  try {
    const file = join(dir, '.env')
    // Missing file → creates with the one line.
    upsertEnvValue(file, 'DATABASE_URL', 'postgresql://a')
    assert.equal(readFileSync(file, 'utf8'), 'DATABASE_URL=postgresql://a\n')

    // Existing file → value replaced, comments/other keys untouched.
    writeFileSync(file, '# keep me\nPORT=47191\nDATABASE_URL=old\n')
    upsertEnvValue(file, 'DATABASE_URL', 'postgresql://new')
    upsertEnvValue(file, 'APP_DATA_DIR', 'C:/data dir')
    const out = readFileSync(file, 'utf8')
    assert.match(out, /^# keep me$/m)
    assert.match(out, /^PORT=47191$/m)
    assert.match(out, /^DATABASE_URL=postgresql:\/\/new$/m)
    assert.match(out, /^APP_DATA_DIR=C:/m)
    assert.equal((out.match(/DATABASE_URL=/g) ?? []).length, 1, 'no duplicate keys')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('appDataDir resolves to the desktop app data folder for this platform', () => {
  // Pin the path contract — the same location Electron's
  // app.getPath('appData') + "Opal Line Billing" resolves to. Deliberately no
  // existsSync(): on a CI runner nothing has provisioned that folder yet, and
  // "a directory exists" is a side effect of running dev.mjs, not of this
  // function.
  const expected =
    process.platform === 'win32'
      ? join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Opal Line Billing')
      : process.platform === 'darwin'
        ? join(homedir(), 'Library', 'Application Support', 'Opal Line Billing')
        : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'Opal Line Billing')
  assert.equal(appDataDir(), expected)
})
