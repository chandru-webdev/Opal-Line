// End-to-end proof for product images:
//   upload multiple local images → save product → show in list/detail →
//   push to Shopify from the LOCAL PATH (base64 attachment) →
//   edit + re-push as an UPDATE (new image + title) →
//   re-push again (no duplicate images) → cleanup.
// All HTTP via node fetch (correct UTF-8). Never prints secrets.
import { readFileSync, readdirSync } from 'node:fs'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Was hardcoded to the original dev machine's ~/Downloads/Opal_project copy.
// Default to THIS repo's backend/ — override with OPAL_BACKEND_DIR=... if the
// dev stack genuinely lives elsewhere.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const BACKEND_DIR = process.env.OPAL_BACKEND_DIR ?? join(repoRoot, 'backend')

const BASE = 'http://localhost:47191'
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

// ── cookie/csrf plumbing ──────────────────────────────────────────────
function mergeJar(jar, setCookies) {
  const map = new Map()
  for (const part of jar.split('; ').filter(Boolean)) {
    const i = part.indexOf('=')
    if (i > 0) map.set(part.slice(0, i), part.slice(i + 1))
  }
  for (const s of setCookies) {
    const kv = s.split(';')[0]
    const i = kv.indexOf('=')
    if (i > 0) map.set(kv.slice(0, i), kv.slice(i + 1))
  }
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
}
async function getCsrf(jar) {
  const r = await fetch(`${BASE}/api/v1/csrf-token`, { headers: { Cookie: jar } })
  const next = mergeJar(jar, r.headers.getSetCookie?.() ?? [])
  const { csrfToken } = await r.json()
  return { jar: next, csrfToken }
}
async function api(path, opts = {}, jar, token) {
  const headers = { ...(opts.headers ?? {}), Cookie: jar }
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
  if (token) headers['X-CSRF-Token'] = token
  const res = await fetch(`${BASE}/api/v1${path}`, { ...opts, headers })
  let json = null
  try { json = await res.json() } catch { /* non-json */ }
  return { status: res.status, json }
}

// ── login ─────────────────────────────────────────────────────────────
let { jar, csrfToken } = await getCsrf('')
const loginRes = await fetch(`${BASE}/api/v1/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken, Cookie: jar },
  body: JSON.stringify({ username: 'admin', password: 'Opal@2026' }),
})
if (loginRes.status !== 200) { console.error('login failed', loginRes.status); process.exit(1) }
jar = mergeJar(jar, loginRes.headers.getSetCookie?.() ?? [])
;({ jar, csrfToken } = await getCsrf(jar))
console.log('logged in')

// ── 1. upload two real local images ───────────────────────────────────
const uploadDir = join(BACKEND_DIR, 'uploads')
const pngs = readdirSync(uploadDir).filter((f) => f.endsWith('.png')).slice(0, 2)
if (pngs.length < 2) { console.error('need 2 test pngs'); process.exit(1) }
const dataUrls = pngs.map((f) => `data:image/png;base64,${readFileSync(join(uploadDir, f)).toString('base64')}`)
const up = await api('/uploads/image', { method: 'POST', body: JSON.stringify({ dataUrls }) }, jar, csrfToken)
check('Upload multiple images', up.status === 200 && (up.json?.paths?.length === 2), `${up.json?.paths?.length ?? 0} paths`)
const paths = up.json?.paths ?? []
if (paths.length < 2) process.exit(1)

// ── 2. create product with ONE image (second arrives via update push) ─
const sku = `IMG-E2E-${Date.now()}`
const createBody = {
  name: 'IMG-E2E Test Product',
  sku,
  category: 'Rings',
  image: paths[0],
  images: [paths[0]],
  status: 'active',
  netWeight: 10,
  grossWeight: 12,
  makingCharge: 20,
  purity: 92.5,
  gst: 3,
  silverRate: 90,
  sellingPrice: 1150,
  stock: 5,
  shopifyStatus: 'not-listed',
  hsn: '71131130',
  createdAt: new Date().toISOString(),
}
const createdRes = await api('/db/products', { method: 'POST', body: JSON.stringify(createBody) }, jar, csrfToken)
check('Create product with local image', createdRes.status === 201 || createdRes.status === 200, `status ${createdRes.status}`)
const localId = createdRes.json?.id
if (!localId) { console.error(createdRes.json); process.exit(1) }

// ── 3. list shows the image + file serves ─────────────────────────────
const list = await api('/db/products?pageSize=100', {}, jar)
const row = (list.json?.data ?? []).find((p) => p.id === localId)
check('Product list carries image', row?.image === paths[0] && Array.isArray(row?.images) && row.images.length === 1, `image=${row?.image}`)
const imgRes = await fetch(`${BASE}${paths[0]}`)
check('Uploaded image serves over HTTP', imgRes.status === 200 && (imgRes.headers.get('content-type') ?? '').startsWith('image/'), `${imgRes.status} ${imgRes.headers.get('content-type')}`)

// ── 4. push NEW product to Shopify from local path ────────────────────
const push1 = await api('/shopify/products/push', { method: 'POST', body: JSON.stringify({ ids: [localId] }) }, jar, csrfToken)
check('Push creates Shopify listing', push1.json?.created === 1 && push1.json?.errors?.length === 0, `created=${push1.json?.created} errors=${JSON.stringify(push1.json?.errors)}`)
const after1 = await api('/db/products?pageSize=100', {}, jar)
const shopifyId = String((after1.json?.data ?? []).find((p) => p.id === localId)?.shopifyId ?? '')
check('Local row linked to Shopify ID', /^\d+$/.test(shopifyId), `shopifyId=${shopifyId}`)

const shopList1 = await api('/shopify/products', {}, jar)
const sp1 = (shopList1.json?.data ?? []).find((p) => String(p.id) === shopifyId)
check('Shopify product has the LOCAL image', Array.isArray(sp1?.images) && sp1.images.length === 1, `images=${sp1?.images?.length}`)

// ── 5. edit: add second image + rename → push as UPDATE ───────────────
const upd = await api(`/db/products/${localId}`, {
  method: 'PATCH',
  body: JSON.stringify({ name: 'IMG-E2E Test Product v2', image: paths[0], images: paths }),
}, jar, csrfToken)
check('Edit product (2nd image + title)', upd.status === 200, `status ${upd.status}`)
const push2 = await api('/shopify/products/push', { method: 'POST', body: JSON.stringify({ ids: [localId] }) }, jar, csrfToken)
check('Re-push updates existing listing', push2.json?.updated === 1 && push2.json?.errors?.length === 0, `updated=${push2.json?.updated} errors=${JSON.stringify(push2.json?.errors)}`)

const shopList2 = await api('/shopify/products', {}, jar)
const sp2 = (shopList2.json?.data ?? []).find((p) => String(p.id) === shopifyId)
check('Shopify now has BOTH local images', Array.isArray(sp2?.images) && sp2.images.length === 2, `images=${sp2?.images?.length}`)
check('Title change pushed to Shopify', sp2?.title === 'IMG-E2E Test Product v2', `title=${sp2?.title}`)

// ── 6. push a THIRD time — must NOT duplicate images ──────────────────
const push3 = await api('/shopify/products/push', { method: 'POST', body: JSON.stringify({ ids: [localId] }) }, jar, csrfToken)
check('Third push succeeds', push3.json?.errors?.length === 0, `updated=${push3.json?.updated}`)
const shopList3 = await api('/shopify/products', {}, jar)
const sp3 = (shopList3.json?.data ?? []).find((p) => String(p.id) === shopifyId)
check('No duplicate images after re-push', Array.isArray(sp3?.images) && sp3.images.length === 2, `images=${sp3?.images?.length}`)

// ── cleanup: local row + Shopify listing ──────────────────────────────
const del = await api(`/db/products/${localId}`, { method: 'DELETE' }, jar, csrfToken)
check('Cleanup: local product deleted', del.status === 200 || del.status === 204, `status ${del.status}`)
if (/^\d+$/.test(shopifyId)) {
  try {
    const devEnv = readFileSync(join(BACKEND_DIR, '.env'), 'utf8')
    const devKey = readFileSync(join(BACKEND_DIR, '.encryption-key'), 'utf8')
    const ivLen = 16, tagLen = 16
    const dec = (v) => {
      const buf = Buffer.from(v.slice(6), 'base64')
      const d = createDecipheriv('aes-256-gcm', Buffer.from(devKey.trim(), 'hex'), buf.subarray(0, ivLen))
      d.setAuthTag(buf.subarray(ivLen, ivLen + tagLen))
      return d.update(buf.subarray(ivLen + tagLen), undefined, 'utf8') + d.final('utf8')
    }
    const token = (() => { const m = devEnv.match(/^SHOPIFY_ACCESS_TOKEN=(.*)$/m); return m && m[1].startsWith('encV1:') ? dec(m[1]) : (m?.[1] ?? '') })()
    const shop = (() => { const m = devEnv.match(/^SHOPIFY_STORE_URL=(.*)$/m); let v = m && m[1].startsWith('encV1:') ? dec(m[1]) : (m?.[1] ?? ''); return v.replace(/^https?:\/\//, '').replace(/\.myshopify\.com.*$/, '') })()
    const r = await fetch(`https://${shop}.myshopify.com/admin/api/2025-10/products/${shopifyId}.json`, {
      method: 'DELETE',
      headers: { 'X-Shopify-Access-Token': token, Accept: 'application/json' },
    })
    check('Cleanup: Shopify test listing deleted', r.status === 200 || r.status === 404, `status ${r.status}`)
  } catch (e) {
    check('Cleanup: Shopify test listing deleted', false, String(e).slice(0, 80))
  }
}

const failed = results.filter((r) => !r.ok)
console.log(`\n===== ${results.length - failed.length}/${results.length} passed =====`)
process.exit(failed.length ? 1 : 0)
