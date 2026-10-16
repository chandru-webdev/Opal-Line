// Repairs the installed app's %APPDATA% .env after a cross-key transplant.
// - Reads encV1 values that were written verbatim from the DEV .env
// - Decrypts them with the DEV master key (backend/.encryption-key)
// - Re-writes: non-secret keys as plaintext, secret keys encrypted with the
//   INSTALLED master key (%APPDATA%/Opal Line Billing/data/.encryption-key)
// Never prints secret values.
import { readFileSync, writeFileSync } from 'node:fs'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Was hardcoded to the original dev machine's ~/Downloads/Opal_project copy.
// Default to THIS repo's backend/ — override with OPAL_BACKEND_DIR=... if the
// dev stack genuinely lives elsewhere.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const BACKEND_DIR = process.env.OPAL_BACKEND_DIR ?? join(repoRoot, 'backend')
const DEV_ENV = join(BACKEND_DIR, '.env')
const DEV_KEY = join(BACKEND_DIR, '.encryption-key')
const DATA_DIR = process.env.APPDATA
  ? join(process.env.APPDATA, 'Opal Line Billing', 'data')
  : null
if (!DATA_DIR) { console.error('no APPDATA'); process.exit(1) }
const APP_ENV = join(DATA_DIR, '.env')
const APP_KEY = join(DATA_DIR, '.encryption-key')

const SECRET_KEYS = new Set(['SHOPIFY_ACCESS_TOKEN', 'ORDER_EMAIL_PASSWORD'])
const TARGETS = ['SHOPIFY_STORE_URL', 'SHOPIFY_ACCESS_TOKEN', 'ORDER_EMAIL_PASSWORD']

const ivLen = 16, tagLen = 16
function dec(keyHex, b64) {
  const key = Buffer.from(keyHex.trim(), 'hex')
  const buf = Buffer.from(b64, 'base64')
  const d = createDecipheriv('aes-256-gcm', key, buf.subarray(0, ivLen))
  d.setAuthTag(buf.subarray(ivLen, ivLen + tagLen))
  return d.update(buf.subarray(ivLen + tagLen), undefined, 'utf8') + d.final('utf8')
}
function enc(keyHex, text) {
  const key = Buffer.from(keyHex.trim(), 'hex')
  const iv = randomBytes(ivLen)
  const c = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([c.update(text, 'utf8'), c.final()])
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64')
}

const devKey = readFileSync(DEV_KEY, 'utf8')
const appKey = readFileSync(APP_KEY, 'utf8')
const devLines = readFileSync(DEV_ENV, 'utf8').split(/\r?\n/)
const appLines = readFileSync(APP_ENV, 'utf8').split(/\r?\n/)

// 1. Get plaintext of the 3 values from the dev env
const plain = {}
for (const line of devLines) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (!m || !TARGETS.includes(m[1])) continue
  plain[m[1]] = m[2].startsWith('encV1:') ? dec(devKey, m[2].slice(6)) : m[2]
}
for (const k of TARGETS) if (!plain[k]) { console.error('missing in dev env: ' + k); process.exit(1) }

// 2. Rewrite app env lines
let updated = []
const out = appLines.map((line) => {
  const m = line.match(/^([A-Z0-9_]+)=/)
  if (!m || !TARGETS.includes(m[1])) return line
  const k = m[1]
  const value = SECRET_KEYS.has(k) ? 'encV1:' + enc(appKey, plain[k]) : plain[k]
  updated.push(k + (SECRET_KEYS.has(k) ? ' (re-encrypted with installed key)' : ' (plaintext)'))
  return k + '=' + value
})
writeFileSync(APP_ENV, out.join('\n'), { mode: 0o600 })
console.log('updated: ' + updated.join(', '))
