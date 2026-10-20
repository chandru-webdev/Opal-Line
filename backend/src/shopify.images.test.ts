/**
 * Unit tests for the Shopify image push/write-back logic fixed by:
 *   - 0952017 — verified image deletes, survivors-only write-back,
 *     stale-CDN drop on sync
 *   - 78fe34f — wait for Shopify's async image processing before writing back
 *
 * No network and no database: global fetch is stubbed, and DATABASE_URL is
 * cleared before ./shopify loads so importing it never opens a connection
 * (dotenv is module-cached, so config.ts / db/client.ts will not resurrect
 * the value when they import it afterwards).
 */
import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import 'dotenv/config'

process.env.SHOPIFY_STORE_URL = 'https://opal-line-test.myshopify.com'
process.env.SHOPIFY_ACCESS_TOKEN = 'shpat_test_token'
process.env.SHOPIFY_API_VERSION = '2024-10'
delete process.env.DATABASE_URL

const CDN = 'https://cdn.shopify.com/shop/files/opal'

type FetchCall = { url: string; method: string }
type Scripted = { status: number; body?: unknown }

let calls: FetchCall[] = []
let script: (call: FetchCall) => Scripted = () => ({ status: 500 })

const originalFetch = globalThis.fetch

function jsonResponse(status: number, body: unknown = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

let shopify: typeof import('./shopify')

before(async () => {
  shopify = await import('./shopify')
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: FetchCall = { url: String(input), method: init?.method ?? 'GET' }
    calls.push(call)
    const res = script(call)
    return jsonResponse(res.status, res.body)
  }) as typeof fetch
})

after(() => {
  globalThis.fetch = originalFetch
})

beforeEach(() => {
  calls = []
  script = () => ({ status: 500 })
})

const listedImages = (...images: Array<{ id?: number; src: string; alt?: string }>) => ({
  product: { images },
})

describe('mergeImages (stale-CDN drop on sync)', () => {
  test('drops a Shopify CDN ref that is no longer on the listing', () => {
    const out = shopify.mergeImages(
      [`${CDN}/gone-placeholder.png`, '/uploads/studio-ring.jpg'],
      [`${CDN}/studio-ring.jpg`],
    )
    assert.deepEqual(out, [`${CDN}/studio-ring.jpg`])
  })

  test('keeps local-only entries that are not represented on the listing', () => {
    const out = shopify.mergeImages(['/uploads/unique-necklace.jpg'], [`${CDN}/studio-ring.jpg`])
    assert.deepEqual(out, [`${CDN}/studio-ring.jpg`, '/uploads/unique-necklace.jpg'])
  })

  test('does not duplicate a local upload already pushed to the listing', () => {
    const out = shopify.mergeImages(['/uploads/studio-ring.jpg'], [`${CDN}/studio-ring.jpg`])
    assert.deepEqual(out, [`${CDN}/studio-ring.jpg`])
  })

  test('falls back to whichever side has images', () => {
    assert.deepEqual(shopify.mergeImages(['/uploads/a.jpg'], []), ['/uploads/a.jpg'])
    assert.deepEqual(shopify.mergeImages(null, [`${CDN}/b.jpg`]), [`${CDN}/b.jpg`])
    assert.equal(shopify.mergeImages(null, []), null)
    assert.equal(shopify.mergeImages([], []), null)
  })
})

describe('deleteShopifyImageWithRetry (verified deletes)', () => {
  test('returns true when Shopify confirms the delete', async () => {
    script = () => ({ status: 200, body: {} })
    assert.equal(await shopify.deleteShopifyImageWithRetry(9, 101), true)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].method, 'DELETE')
    assert.match(calls[0].url, /\/products\/9\/images\/101\.json$/)
  })

  test('treats 404 as already gone', async () => {
    script = () => ({ status: 404 })
    assert.equal(await shopify.deleteShopifyImageWithRetry(9, 102), true)
    assert.equal(calls.length, 1)
  })

  test('does not retry a non-retryable 4xx status', async () => {
    script = () => ({ status: 400, body: {} })
    assert.equal(await shopify.deleteShopifyImageWithRetry(9, 103), false)
    assert.equal(calls.length, 1)
  })

  test('retries 429 with backoff until the delete succeeds', async () => {
    script = () => (calls.length < 3 ? { status: 429 } : { status: 200, body: {} })
    assert.equal(await shopify.deleteShopifyImageWithRetry(9, 104), true)
    assert.equal(calls.length, 3)
  })

  test('gives up only after the 5xx retries are exhausted', async () => {
    script = () => ({ status: 503 })
    assert.equal(await shopify.deleteShopifyImageWithRetry(9, 105), false)
    assert.equal(calls.length, 3)
  })
})

describe('reconcileListingImages (survivors-only write-back)', () => {
  test('writes back only kept survivors and verifies the stale delete', async () => {
    const stale = `${CDN}/placeholder-old.png`
    const keep = `${CDN}/keep-me.png`
    script = (call) =>
      call.method === 'DELETE'
        ? { status: 200, body: {} }
        : { status: 200, body: listedImages({ id: 101, src: stale }, { id: 102, src: keep, alt: 'keep-me.png' }) }

    const writebacks: Array<Array<{ src?: string }> | undefined> = []
    const res = await shopify.reconcileListingImages(
      7,
      ['/uploads/keep-me.png'],
      new Set(),
      async (imgs) => { writebacks.push(imgs) },
    )

    // Regression (0952017): the write-back used to record the pre-delete
    // snapshot, re-adding the poisoned placeholder on every re-push.
    assert.equal(writebacks.length, 1)
    assert.deepEqual((writebacks[0] ?? []).map((i) => i.src), [keep])
    assert.equal(res.deleted, 1)
    assert.equal(res.kept.length, 1)

    const deletes = calls.filter((c) => c.method === 'DELETE')
    assert.equal(deletes.length, 1)
    assert.match(deletes[0].url, /\/products\/7\/images\/101\.json$/)
    assert.ok(!deletes.some((c) => c.url.endsWith('/images/102.json')), 'kept image must not be deleted')
  })

  test('waits for Shopify async image processing before writing back', async () => {
    const keep = `${CDN}/keep-me.png`
    const added = `${CDN}/just-added.png`
    let gets = 0
    script = (call) => {
      if (call.method !== 'GET') return { status: 404 }
      gets++
      // The just-added image only becomes visible on the listing later.
      const images = gets === 1
        ? [{ id: 102, src: keep, alt: 'keep-me.png' }]
        : [{ id: 102, src: keep, alt: 'keep-me.png' }, { id: 103, src: added }]
      return { status: 200, body: listedImages(...images) }
    }

    const writebacks: Array<Array<{ src?: string }> | undefined> = []
    const res = await shopify.reconcileListingImages(
      7,
      ['/uploads/keep-me.png'],
      new Set([new URL(added).pathname]),
      async (imgs) => { writebacks.push(imgs) },
    )

    // Regression (78fe34f): writing back before the processor caught up left
    // the local row on the old local path. The listing must be re-fetched.
    assert.ok(gets >= 2, `expected a re-fetch, saw ${gets} GET(s)`)
    assert.equal(writebacks.length, 1)
    assert.deepEqual((writebacks[0] ?? []).map((i) => i.src), [keep, added])
    assert.equal(res.kept.length, 2)
  })

  test('excludes a stale image from the write-back even when its delete keeps failing', async () => {
    const stale = `${CDN}/placeholder-old.png`
    const keep = `${CDN}/keep-me.png`
    script = (call) =>
      call.method === 'DELETE'
        ? { status: 429 }
        : { status: 200, body: listedImages({ id: 101, src: stale }, { id: 102, src: keep, alt: 'keep-me.png' }) }

    const writebacks: Array<Array<{ src?: string }> | undefined> = []
    const res = await shopify.reconcileListingImages(
      7,
      ['/uploads/keep-me.png'],
      new Set(),
      async (imgs) => { writebacks.push(imgs) },
    )

    assert.equal(res.deleted, 0)
    assert.equal(writebacks.length, 1)
    assert.deepEqual((writebacks[0] ?? []).map((i) => i.src), [keep])
  })

  test('passes undefined to the write-back when nothing survives on the listing', async () => {
    const stale = `${CDN}/placeholder-old.png`
    script = (call) =>
      call.method === 'DELETE'
        ? { status: 200, body: {} }
        : { status: 200, body: listedImages({ id: 101, src: stale }) }

    const args: Array<{ called: boolean; wasUndefined: boolean }> = []
    const res = await shopify.reconcileListingImages(
      7,
      ['/uploads/keep-me.png'],
      new Set(),
      async (imgs) => { args.push({ called: true, wasUndefined: imgs === undefined }) },
    )

    assert.deepEqual(args, [{ called: true, wasUndefined: true }])
    assert.deepEqual(res.kept, [])
    assert.equal(res.deleted, 1)
  })

  test('never touches the listing when the local gallery is empty', async () => {
    const res = await shopify.reconcileListingImages(
      7,
      [],
      new Set(),
      async () => { assert.fail('write-back must not run for an empty local gallery') },
    )
    assert.deepEqual(res, { kept: [], deleted: 0 })
    assert.equal(calls.length, 0, 'no Shopify calls for an empty local gallery')
  })
})

const baseLocal = (over: Partial<Parameters<typeof shopify.buildShopifyImages>[0]> = {}) => ({
  id: 'p1', name: 'Test Ring', sku: 'SKU1', barcode: null, huid: null, category: null,
  collection: null, purity: null, supplier: null, vendor: null, productType: null,
  description: null, tags: null, image: null, images: null, sellingPrice: null,
  compareAtPrice: null, stock: null, trackInventory: null, chargeOnTax: null,
  shopifyId: null, shopifyStatus: null, status: null,
  ...over,
})

describe('buildShopifyImages (image policy: only user-provided images push)', () => {
  test('keeps data URLs and external URLs', async () => {
    const imgs = await shopify.buildShopifyImages(baseLocal({
      images: ['data:image/png;base64,AAA', 'https://example.com/ring.jpg'],
    }))
    // data URL → attachment, external → src (uploads are disk-backed and are
    // covered by the CDN-filter semantics, not testable without a real file)
    assert.equal(imgs.length, 2)
    assert.ok(imgs.every((i) => i.attachment || i.src))
  })

  test('never pushes cdn.shopify.com round-trip URLs', async () => {
    const imgs = await shopify.buildShopifyImages(baseLocal({
      image: 'https://cdn.shopify.com/s/files/1/0001/files/from-shopify.jpg?v=1',
      images: [
        'https://cdn.shopify.com/s/files/1/0001/files/gallery.jpg?v=2',
        'data:image/jpeg;base64,BBB',
      ],
    }))
    assert.equal(imgs.length, 1, 'only the user-provided data URL survives')
    assert.ok(imgs[0].attachment)
  })

  test('all-CDN gallery pushes nothing (create stays imageless, no random images)', async () => {
    const imgs = await shopify.buildShopifyImages(baseLocal({
      id: 'p3',
      sku: 'SKU3',
      image: 'https://cdn.shopify.com/s/files/1/0001/files/a.jpg',
      images: ['https://cdn.shopify.com/s/files/1/0001/files/b.jpg'],
    }))
    assert.deepEqual(imgs, [])
  })
})
