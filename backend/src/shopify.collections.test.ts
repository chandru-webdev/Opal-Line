/**
 * Two-way Shopify collections sync:
 *   - pull: collect memberships (custom + smart collection titles) attach to
 *     the in-memory catalog, including memberships past the first page;
 *   - push: syncLocalCollectionMembership creates/keeps real collect rows so a
 *     product actually joins its Shopify collection, skips smart collections
 *     (POSTing a collect for one is a 403), and removes exactly the membership
 *     the app itself pushed when the local collection changes;
 *   - a collections endpoint failure never fails the catalog pull, and never
 *     throws out of the membership sync (it is recorded instead).
 *
 * The regression behind this file: pushes only wrote an `opal-collection:` tag
 * and mirrored the value into product_type — no collect was ever created, so
 * storefront collections never received the product while the app showed it
 * as synced.
 *
 * No network and no database: global fetch is stubbed, and DATABASE_URL is
 * cleared before ./shopify loads so importing it never opens a connection.
 */
import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import 'dotenv/config'

process.env.SHOPIFY_STORE_URL = 'https://opal-line-test.myshopify.com'
process.env.SHOPIFY_ACCESS_TOKEN = 'shpat_test_token'
process.env.SHOPIFY_API_VERSION = '2024-10'
delete process.env.DATABASE_URL

type FetchCall = { url: string; method: string; body?: unknown }
type Scripted = { status: number; body?: unknown; link?: string; retryAfter?: string }

let calls: FetchCall[] = []
let script: (call: FetchCall) => Scripted = () => ({ status: 404 })

const originalFetch = globalThis.fetch

function jsonResponse(status: number, body: unknown = {}, link?: string, retryAfter?: string): Response {
  const headers: Record<string, string> = {}
  if (link) headers.link = link
  if (retryAfter) headers['Retry-After'] = retryAfter
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

let shopify: typeof import('./shopify')

before(async () => {
  shopify = await import('./shopify')
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: FetchCall = { url: String(input), method: init?.method ?? 'GET' }
    if (typeof init?.body === 'string') {
      try {
        call.body = JSON.parse(init.body)
      } catch {
        call.body = init.body
      }
    }
    calls.push(call)
    const res = script(call)
    return jsonResponse(res.status, res.body, res.link, res.retryAfter)
  }) as typeof fetch
})

after(() => {
  globalThis.fetch = originalFetch
})

beforeEach(() => {
  calls = []
  script = () => ({ status: 404 })
  shopify.resetCollectionDirectory()
})

function isMethod(call: FetchCall, method: string): boolean {
  return call.method === method
}

function isResource(call: FetchCall, resource: string, method = 'GET'): boolean {
  return isMethod(call, method) && call.url.includes(`/${resource}.json`)
}

describe('collectionSegments / collectionFromTags', () => {
  test('splits a joined collection field into titles', () => {
    assert.deepEqual(shopify.collectionSegments('Classic'), ['Classic'])
    assert.deepEqual(shopify.collectionSegments('Classic | Modern'), ['Classic', 'Modern'])
    assert.deepEqual(shopify.collectionSegments(' a | a | b '), ['a', 'b'])
    assert.deepEqual(shopify.collectionSegments(null), [])
    assert.deepEqual(shopify.collectionSegments('  | '), [])
  })

  test('reads the opal-collection tag, tolerating strings, arrays and absence', () => {
    assert.equal(shopify.collectionFromTags('opal-collection:Classic, huid:H1'), 'Classic')
    assert.equal(shopify.collectionFromTags(['opal-collection:Modern']), 'Modern')
    assert.equal(shopify.collectionFromTags('opal-collection: , other'), null)
    assert.equal(shopify.collectionFromTags('no tags here'), null)
    assert.equal(shopify.collectionFromTags(undefined), null)
  })
})

describe('attachCollectionsToProducts (pull)', () => {
  test('attaches Shopify collection titles to the products that belong to them', async () => {
    shopify.store.products = [
      shopify.normalizeProduct({ id: 111, title: 'Ring', tags: 'opal-collection:Classic', product_type: 'Rings', variants: [{ sku: 'A1' }] }),
      shopify.normalizeProduct({ id: 222, title: 'Bangle', tags: '', product_type: 'Bangles', variants: [{ sku: 'A2' }] }),
    ]
    script = (call) => {
      if (isResource(call, 'custom_collections')) return { status: 200, body: { custom_collections: [{ id: 1, title: 'Signature' }] } }
      if (isResource(call, 'smart_collections')) return { status: 200, body: { smart_collections: [{ id: 2, title: 'New Arrivals' }] } }
      if (isResource(call, 'collects')) return { status: 200, body: { collects: [{ id: 9, collection_id: 1, product_id: 111 }] } }
      return { status: 404 }
    }
    await shopify.attachCollectionsToProducts()
    const inCollection = shopify.store.products.find((p) => p.id === 111)
    const untouched = shopify.store.products.find((p) => p.id === 222)
    assert(inCollection)
    assert(untouched)
    // Real membership plus the tag-derived fallback (kept so it never regresses).
    assert.equal(inCollection.collection, 'Classic | Signature')
    assert.equal(untouched.collection, 'Bangles')
  })

  test('paginates collects so memberships past page one still attach', async () => {
    shopify.store.products = [
      shopify.normalizeProduct({ id: 333, title: 'Chain', tags: '', product_type: 'Chains', variants: [{ sku: 'B1' }] }),
    ]
    let collectPage = 0
    script = (call) => {
      if (isResource(call, 'collects')) {
        collectPage += 1
        if (collectPage === 1) {
          return {
            status: 200,
            body: { collects: [] },
            link: '<https://opal-line-test.myshopify.com/admin/api/2024-10/collects.json?limit=250&page_info=nexthere>; rel="next"',
          }
        }
        return { status: 200, body: { collects: [{ id: 10, collection_id: 5, product_id: 333 }] } }
      }
      if (isResource(call, 'custom_collections')) return { status: 200, body: { custom_collections: [{ id: 5, title: 'Hoarded' }] } }
      if (isResource(call, 'smart_collections')) return { status: 200, body: { smart_collections: [] } }
      return { status: 404 }
    }
    await shopify.attachCollectionsToProducts()
    const product = shopify.store.products.find((p) => p.id === 333)
    assert(product)
    // Membership from page two, ahead of the product_type fallback.
    assert.equal(product.collection, 'Chains | Hoarded')
    const collectCalls = calls.filter((c) => isResource(c, 'collects'))
    assert.equal(collectCalls.length, 2)
    assert.match(collectCalls[1].url, /page_info=nexthere/)
  })

  test('a failing collections endpoint never fails the catalog pull', async () => {
    Reflect.deleteProperty(shopify.store.lastSync, 'products')
    script = (call) => {
      if (isResource(call, 'products')) {
        return { status: 200, body: { products: [{ id: 444, title: 'Chain', product_type: 'Chains', tags: '', variants: [{ sku: 'CH-1', price: '100' }] }] } }
      }
      if (isResource(call, 'locations')) return { status: 200, body: { locations: [] } }
      if (call.url.includes('custom_collections')) return { status: 400 }
      if (call.url.includes('smart_collections')) return { status: 400 }
      if (call.url.includes('collects')) return { status: 400 }
      return { status: 404 }
    }
    // Must resolve (not reject): collections failures are recorded, not fatal.
    await shopify.ensureSynced('products')
    assert.equal(shopify.store.products.length, 1)
    // Without collection membership the tag/product_type fallback applies.
    assert.equal(shopify.store.products[0].collection, 'Chains')
    assert.ok(shopify.store.lastSync.products)
  })
})

describe('syncLocalCollectionMembership (push)', () => {
  test('adds the product to an existing custom collection', async () => {
    script = (call) => {
      if (isResource(call, 'custom_collections')) return { status: 200, body: { custom_collections: [{ id: 7, title: 'Classic' }] } }
      if (isResource(call, 'smart_collections')) return { status: 200, body: { smart_collections: [] } }
      if (isResource(call, 'collects')) return { status: 200, body: { collects: [] } }
      if (isResource(call, 'collects', 'POST')) return { status: 201, body: { collect: { id: 501, product_id: 91, collection_id: 7 } } }
      return { status: 404 }
    }
    const out = await shopify.syncLocalCollectionMembership(91, 'Classic')
    assert.deepEqual(out.added, ['Classic'])
    assert.deepEqual(out.errors, [])
    const post = calls.find((c) => isResource(c, 'collects', 'POST'))
    assert(post, 'expected POST /collects.json')
    assert.deepEqual(post.body, { collect: { product_id: 91, collection_id: 7 } })
  })

  test('creates the custom collection when the store has none, caching it for the batch', async () => {
    script = (call) => {
      if (isResource(call, 'custom_collections')) return { status: 200, body: { custom_collections: [] } }
      if (isResource(call, 'custom_collections', 'POST')) return { status: 201, body: { custom_collection: { id: 77 } } }
      if (isResource(call, 'smart_collections')) return { status: 200, body: { smart_collections: [] } }
      if (isResource(call, 'collects')) return { status: 200, body: { collects: [] } }
      if (isResource(call, 'collects', 'POST')) return { status: 201, body: { collect: { id: 1 } } }
      return { status: 404 }
    }
    const out = await shopify.syncLocalCollectionMembership(91, 'Heirloom')
    assert.deepEqual(out.added, ['Heirloom'])
    const create = calls.find((c) => isResource(c, 'custom_collections', 'POST'))
    assert(create, 'expected POST /custom_collections.json')
    assert.deepEqual(create.body, { custom_collection: { title: 'Heirloom' } })
    const add = calls.find((c) => isResource(c, 'collects', 'POST'))
    assert(add, 'expected POST /collects.json')
    assert.deepEqual(add.body, { collect: { product_id: 91, collection_id: 77 } })

    // Second product, same title: directory is cached — no duplicate collection.
    calls = []
    const out2 = await shopify.syncLocalCollectionMembership(92, 'Heirloom')
    assert.deepEqual(out2.added, ['Heirloom'])
    assert.equal(calls.filter((c) => isResource(c, 'custom_collections', 'POST')).length, 0)
    const add2 = calls.find((c) => isResource(c, 'collects', 'POST'))
    assert(add2, 'expected POST /collects.json for the second product')
    assert.deepEqual(add2.body, { collect: { product_id: 92, collection_id: 77 } })
  })

  test('skips smart collections instead of POSTing a collect (they 403)', async () => {
    script = (call) => {
      if (isResource(call, 'custom_collections')) return { status: 200, body: { custom_collections: [] } }
      if (isResource(call, 'smart_collections')) return { status: 200, body: { smart_collections: [{ id: 3, title: 'Sale' }] } }
      return { status: 404 }
    }
    const out = await shopify.syncLocalCollectionMembership(91, 'Sale')
    assert.deepEqual(out.skipped, ['Sale'])
    assert.deepEqual(out.added, [])
    assert.deepEqual(out.errors, [])
    assert.equal(calls.filter((c) => isResource(c, 'collects', 'POST')).length, 0)
  })

  test('treats an existing membership as already in sync', async () => {
    script = (call) => {
      if (isResource(call, 'custom_collections')) return { status: 200, body: { custom_collections: [{ id: 7, title: 'Classic' }] } }
      if (isResource(call, 'smart_collections')) return { status: 200, body: { smart_collections: [] } }
      if (isResource(call, 'collects')) return { status: 200, body: { collects: [{ id: 55, product_id: 91, collection_id: 7 }] } }
      return { status: 404 }
    }
    const out = await shopify.syncLocalCollectionMembership(91, 'Classic')
    assert.deepEqual(out.existing, ['Classic'])
    assert.deepEqual(out.added, [])
    assert.equal(calls.filter((c) => isResource(c, 'collects', 'POST')).length, 0)
  })

  test('tolerates the duplicate-membership race (422) without an error', async () => {
    script = (call) => {
      if (isResource(call, 'custom_collections')) return { status: 200, body: { custom_collections: [{ id: 7, title: 'Classic' }] } }
      if (isResource(call, 'smart_collections')) return { status: 200, body: { smart_collections: [] } }
      if (isResource(call, 'collects')) return { status: 200, body: { collects: [] } }
      if (isResource(call, 'collects', 'POST')) return { status: 422, body: { errors: { product_id: ['has already been taken'] } } }
      return { status: 404 }
    }
    const out = await shopify.syncLocalCollectionMembership(91, 'Classic')
    assert.deepEqual(out.existing, ['Classic'])
    assert.deepEqual(out.errors, [])
  })

  test('adds the new membership and removes the one the app set earlier', async () => {
    script = (call) => {
      if (isResource(call, 'custom_collections')) {
        return { status: 200, body: { custom_collections: [{ id: 7, title: 'Classic' }, { id: 8, title: 'Modern' }] } }
      }
      if (isResource(call, 'smart_collections')) return { status: 200, body: { smart_collections: [] } }
      if (isResource(call, 'collects')) {
        const collectionId = new URL(call.url).searchParams.get('collection_id')
        if (collectionId === '7') return { status: 200, body: { collects: [{ id: 55, product_id: 91, collection_id: 7 }] } }
        return { status: 200, body: { collects: [] } }
      }
      if (isResource(call, 'collects', 'POST')) return { status: 201, body: { collect: { id: 601 } } }
      if (isMethod(call, 'DELETE') && call.url.includes('/collects/55.json')) return { status: 200, body: {} }
      return { status: 404 }
    }
    const out = await shopify.syncLocalCollectionMembership(91, 'Modern', 'Classic')
    assert.deepEqual(out.added, ['Modern'])
    assert.deepEqual(out.removed, ['Classic'])
    assert.deepEqual(out.errors, [])
    const del = calls.find((c) => isMethod(c, 'DELETE'))
    assert(del, 'expected DELETE /collects/55.json')
    assert.match(del.url, /\/collects\/55\.json$/)
  })

  test('keeps memberships that are still in the local collection value', async () => {
    script = (call) => {
      if (isResource(call, 'custom_collections')) return { status: 200, body: { custom_collections: [{ id: 7, title: 'Classic' }] } }
      if (isResource(call, 'smart_collections')) return { status: 200, body: { smart_collections: [] } }
      if (isResource(call, 'collects')) return { status: 200, body: { collects: [{ id: 55, product_id: 91, collection_id: 7 }] } }
      return { status: 404 }
    }
    const out = await shopify.syncLocalCollectionMembership(91, 'Classic | Other', 'Classic')
    assert.deepEqual(out.existing, ['Classic'])
    assert.deepEqual(out.removed, [])
    assert.equal(calls.filter((c) => isMethod(c, 'DELETE')).length, 0)
  })

  test('retries a throttled membership read (429) instead of failing the sync', async () => {
    // Regression: bare fetch meant one throttle burst failed the whole
    // membership sync with "Shopify API error 429 while reading collection
    // membership" (live run 37584384670, step 9).
    let membershipReads = 0
    script = (call) => {
      if (isResource(call, 'custom_collections')) return { status: 200, body: { custom_collections: [{ id: 7, title: 'Classic' }] } }
      if (isResource(call, 'smart_collections')) return { status: 200, body: { smart_collections: [] } }
      if (isResource(call, 'collects', 'GET')) {
        membershipReads++
        if (membershipReads === 1) return { status: 429, body: { errors: 'Throttled' }, retryAfter: '0' }
        return { status: 200, body: { collects: [] } }
      }
      if (isResource(call, 'collects', 'POST')) return { status: 201, body: { collect: { id: 501 } } }
      return { status: 404 }
    }
    const out = await shopify.syncLocalCollectionMembership(91, 'Classic')
    assert.deepEqual(out.errors, [])
    assert.deepEqual(out.added, ['Classic'])
    assert.equal(membershipReads, 2, 'expected the throttled GET to be retried')
  })

  test('records failures without throwing when the collections API rejects', async () => {
    script = (call) => {
      if (call.url.includes('custom_collections')) return { status: 400 }
      if (call.url.includes('smart_collections')) return { status: 400 }
      return { status: 404 }
    }
    // Must not throw — a membership failure can never fail the product push.
    const out = await shopify.syncLocalCollectionMembership(91, 'Classic')
    assert.equal(out.errors.length, 1)
    assert.deepEqual(out.added, [])
    assert.match(out.errors[0], /Classic: /)
  })

  test('is a no-op without a usable product id or Shopify configuration', async () => {
    const out = await shopify.syncLocalCollectionMembership(0, 'Classic')
    assert.deepEqual(out, { added: [], existing: [], removed: [], skipped: [], errors: [] })
    assert.equal(calls.length, 0)
  })
})
