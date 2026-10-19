import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { envFileValue, upsertEnvValue, parseDbUrl, appDataDir, isLegacySharedDbUrl, isOwnDevDbUrl, migrateEncryptedEnvValues } from './dev.mjs'

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

test('isLegacySharedDbUrl recognizes only the desktop-app cluster URL', () => {
  // The exact shapes dev.mjs itself used to write (old shared setups — first
  // the desktop's opal_line, then the same-cluster opal_line_dev):
  assert.equal(isLegacySharedDbUrl('postgresql://postgres:pw@127.0.0.1:47193/opal_line'), true)
  assert.equal(isLegacySharedDbUrl('postgres://postgres:pw@127.0.0.1:47193/opal_line'), true)
  assert.equal(isLegacySharedDbUrl('postgresql://postgres:pw@127.0.0.1:47193/opal_line_dev'), true, 'same-cluster dev URL from an intermediate script version')
  // Hand-maintained URLs must never be migrated:
  assert.equal(isLegacySharedDbUrl('postgresql://postgres:pw@127.0.0.1:47194/opal_line'), false, 'dev cluster URL is current, not legacy')
  assert.equal(isLegacySharedDbUrl('postgresql://postgres:pw@127.0.0.1:47194/opal_line_dev'), false, 'same name on the new cluster is current')
  assert.equal(isLegacySharedDbUrl('postgresql://postgres:pw@db.example.com:47193/opal_line'), false, 'remote host')
  assert.equal(isLegacySharedDbUrl('postgresql://postgres:pw@127.0.0.1:47193/other_db'), false, 'different database')
  assert.equal(isLegacySharedDbUrl('postgresql://postgres:pw@127.0.0.1:47193/opal_line_dev2'), false, 'look-alike name')
  assert.equal(isLegacySharedDbUrl('postgresql://postgres:pw@127.0.0.1:5432/opal_line'), false, 'different port')
})

test('isOwnDevDbUrl recognizes only the dev cluster this script provisions', () => {
  assert.equal(isOwnDevDbUrl('postgresql://postgres:pw@127.0.0.1:47194/opal_line'), true, 'our own dev URL')
  assert.equal(isOwnDevDbUrl('postgresql://postgres@127.0.0.1:47194/opal_line'), true, 'password-less variant')
  assert.equal(isOwnDevDbUrl('postgresql://postgres:pw@127.0.0.1:47193/opal_line'), false, "desktop app's cluster is handoff, not ours")
  assert.equal(isOwnDevDbUrl('postgresql://postgres:pw@db.example.com:47194/opal_line'), false, 'same port elsewhere is not ours')
  assert.equal(isOwnDevDbUrl('not a url'), false)
  assert.equal(isLegacySharedDbUrl('not a url'), false)
})

// encV1 helpers mirroring backend/src/lib/crypto.ts (aes-256-gcm,
// iv[16]+tag[16]+ciphertext base64) so the migration test can craft values.
const { randomBytes, createCipheriv, createDecipheriv } = await import('node:crypto')
function encV1(keyHex, plaintext) {
  const iv = randomBytes(16)
  const c = createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv)
  const enc = Buffer.concat([c.update(plaintext, 'utf8'), c.final()])
  return 'encV1:' + Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64')
}
function decV1(keyHex, value) {
  const buf = Buffer.from(value.slice('encV1:'.length), 'base64')
  const d = createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), buf.subarray(0, 16))
  d.setAuthTag(buf.subarray(16, 32))
  return d.update(buf.subarray(32), undefined, 'utf8') + d.final('utf8')
}

test('migrateEncryptedEnvValues re-homes encV1 secrets under the current key', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opal-encmig-'))
  try {
    const appKey = randomBytes(32).toString('hex')
    const appKeyFile = join(dir, 'app-key')
    const currentKeyFile = join(dir, 'dev-key')
    writeFileSync(appKeyFile, appKey)
    const envPath = join(dir, '.env')
    writeFileSync(envPath, [
      'DATABASE_URL=postgresql://x',
      `SHOPIFY_STORE_URL=${encV1(appKey, 'https://opal.myshopify.com')}`,
      `SHOPIFY_ACCESS_TOKEN=${encV1(appKey, 'shpat_secret_value')}`,
      'PLAIN_LINE=keep-me',
    ].join('\n'))

    const first = migrateEncryptedEnvValues({ envPath, currentKeyFile, sourceKeyFile: appKeyFile })
    assert.deepEqual(first.migrated.sort(), ['SHOPIFY_ACCESS_TOKEN', 'SHOPIFY_STORE_URL'])
    assert.deepEqual(first.failed, [])

    // Dev key file was created; values decrypt with it to the original plaintext.
    const devKey = readFileSync(currentKeyFile, 'utf8').trim()
    const out = readFileSync(envPath, 'utf8')
    assert.match(out, /^SHOPIFY_STORE_URL=encV1:/m)
    assert.equal(decV1(devKey, out.match(/^SHOPIFY_STORE_URL=(.*)$/m)[1]), 'https://opal.myshopify.com')
    assert.equal(decV1(devKey, out.match(/^SHOPIFY_ACCESS_TOKEN=(.*)$/m)[1]), 'shpat_secret_value')
    assert.match(out, /^PLAIN_LINE=keep-me$/m, 'non-secret lines untouched')
    assert.match(out, /^DATABASE_URL=postgresql:\/\/x$/m)

    // Idempotent: a second run migrates nothing and leaves values intact.
    const before = readFileSync(envPath, 'utf8')
    const second = migrateEncryptedEnvValues({ envPath, currentKeyFile, sourceKeyFile: appKeyFile })
    assert.deepEqual(second.migrated, [])
    assert.equal(readFileSync(envPath, 'utf8'), before)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('migrateEncryptedEnvValues leaves already-current values and reports unopenable ones', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opal-encmig2-'))
  try {
    const currentKey = randomBytes(32).toString('hex')
    const currentKeyFile = join(dir, 'dev-key')
    const sourceKeyFile = join(dir, 'app-key') // different key, does NOT open this value
    writeFileSync(currentKeyFile, currentKey)
    writeFileSync(sourceKeyFile, randomBytes(32).toString('hex'))
    const envPath = join(dir, '.env')
    const already = encV1(currentKey, 'already-mine')
    const foreign = encV1(randomBytes(32).toString('hex'), 'nobody-can-open')
    writeFileSync(envPath, `A=${already}\nB=${foreign}`)

    const r = migrateEncryptedEnvValues({ envPath, currentKeyFile, sourceKeyFile })
    assert.deepEqual(r.migrated, [])
    assert.deepEqual(r.failed, ['B'], 'unopenable under either key is reported, not dropped')
    const out = readFileSync(envPath, 'utf8')
    assert.equal(out.split('\n')[0], `A=${already}`, 'current-key value byte-for-byte untouched')
    assert.equal(out.split('\n')[1], `B=${foreign}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('appDataDir defaults to the desktop app folder; accepts a sibling name', () => {
  // The dev stack must NOT share the desktop app's folder.
  assert.notEqual(appDataDir('Opal Line Billing Dev'), appDataDir())
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
