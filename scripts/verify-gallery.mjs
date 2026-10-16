// Browser check for the product image UI:
//   1. create a temp product with 2 local images
//   2. products list shows the thumbnail
//   3. product detail page shows hero + thumbnail gallery
//   4. cleanup
import { chromium } from 'playwright'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Was hardcoded to the original dev machine's ~/Downloads/Opal_project copy.
// Default to THIS repo's backend/ — override with OPAL_BACKEND_DIR=... if the
// dev stack genuinely lives elsewhere.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const BACKEND_DIR = process.env.OPAL_BACKEND_DIR ?? join(repoRoot, 'backend')

const BASE = process.env.BASE ?? 'http://localhost:47191'

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

let { jar, csrfToken } = await getCsrf('')
const loginRes = await fetch(`${BASE}/api/v1/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken, Cookie: jar },
  body: JSON.stringify({ username: 'admin', password: 'Opal@2026' }),
})
if (loginRes.status !== 200) { console.error('login failed'); process.exit(1) }
jar = mergeJar(jar, loginRes.headers.getSetCookie?.() ?? [])
;({ jar, csrfToken } = await getCsrf(jar))

// temp product with two images
const dir = join(BACKEND_DIR, 'uploads')
const pngs = readdirSync(dir).filter((f) => f.endsWith('.png')).slice(0, 2)
const dataUrls = pngs.map((f) => `data:image/png;base64,${readFileSync(join(dir, f)).toString('base64')}`)
const up = await (await fetch(`${BASE}/api/v1/uploads/image`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken, Cookie: jar },
  body: JSON.stringify({ dataUrls }),
})).json()
const paths = up.paths ?? []
const sku = `GALLERY-DEMO-${Date.now()}`
const created = await (await fetch(`${BASE}/api/v1/db/products`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken, Cookie: jar },
  body: JSON.stringify({
    name: 'Gallery Demo Product', sku, category: 'Rings',
    image: paths[0], images: paths, status: 'active',
    netWeight: 10, makingCharge: 20, purity: 92.5, gst: 3, silverRate: 90, sellingPrice: 1150,
    stock: 2, shopifyStatus: 'not-listed', hsn: '71131130', createdAt: new Date().toISOString(),
  }),
})).json()
console.log('temp product:', created.id, '| images:', paths.length)

let failed = 0
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`) }

const browser = await chromium.launch()
try {
  const page = await browser.newPage()
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
  await page.fill('#username', 'admin')
  await page.fill('#password', 'Opal@2026')
  await page.click('button:has-text("Sign in")')
  await page.waitForURL(`${BASE}/`, { timeout: 15000 }).catch(() => {})

  // list thumbnail
  await page.goto(`${BASE}/inventory/products`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(600)
  const listImg = page.locator(`a img[src*="uploads"]`)
  check('Products list shows an uploaded thumbnail', (await listImg.count()) > 0, `${await listImg.count()} upload imgs in list`)

  // detail gallery
  await page.goto(`${BASE}/inventory/products/${created.id}`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(600)
  const galleryImgs = page.locator(`img[src*="uploads"]`)
  const n = await galleryImgs.count()
  check('Detail page renders gallery images', n >= 2, `${n} images`)
  const hero = page.locator('img[src*="uploads"]').first()
  const heroVisible = await hero.isVisible().catch(() => false)
  check('Hero image visible', heroVisible)
  await page.screenshot({ path: '/tmp/chrome-test/product-detail-gallery.png', fullPage: false })
  console.log('screenshot: /tmp/chrome-test/product-detail-gallery.png')
} catch (e) {
  check('Playwright flow', false, String(e).split('\n')[0].slice(0, 120))
} finally {
  await browser.close()
}

// cleanup temp product
const del = await fetch(`${BASE}/api/v1/db/products/${created.id}`, {
  method: 'DELETE', headers: { 'X-CSRF-Token': csrfToken, Cookie: jar },
})
console.log('cleanup delete:', del.status)
process.exit(failed ? 1 : 0)
