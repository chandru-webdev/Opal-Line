/**
 * Regression tests for the product pull's SKU reconciliation, motivated by
 * the first weekly live check failure (run 37575498349): the store carries
 * two products with SKU SLR-001, and on a brand-new database the pull
 * inserted the first one then collided with products_sku_idx on the second,
 * aborting the entire first import. applyLiveCatalog now registers each
 * fresh row so the next same-SKU product takes the update path.
 *
 * No network and no database: DATABASE_URL is cleared before ./shopify
 * loads, and the injected CatalogApplyIo fake enforces the same unique
 * index that used to kill the import.
 */
import assert from 'node:assert/strict'
import { before, describe, test } from 'node:test'
import 'dotenv/config'
import type { SyncProduct } from './types'
import type { CatalogApplyIo, CatalogInsertValues, CatalogRow } from './shopify'

process.env.SHOPIFY_STORE_URL = 'https://opal-line-test.myshopify.com'
process.env.SHOPIFY_ACCESS_TOKEN = 'shpat_test_token'
delete process.env.DATABASE_URL

let shopify: typeof import('./shopify')

before(async () => {
  shopify = await import('./shopify')
})

function liveProduct(overrides: Partial<SyncProduct>): SyncProduct {
  return {
    id: 1,
    gid: 'gid://shopify/Product/1',
    title: 'Live Product',
    handle: 'live-product',
    vendor: 'Opal Line',
    productType: 'Rings',
    description: '',
    collection: 'Home page',
    chargeOnTax: true,
    status: 'active',
    sku: 'SKU-1',
    barcode: null,
    price: '1500',
    compareAtPrice: null,
    image: null,
    images: [],
    inventoryQuantity: 3,
    inventoryItemId: 0,
    variantId: 0,
    createdAt: '2026-10-07',
    updatedAt: '2026-10-07',
    ...overrides,
  }
}

function localRow(overrides: Partial<CatalogRow> = {}): CatalogRow {
  return {
    id: 'row-1',
    sku: 'SKU-1',
    name: 'Local Product',
    barcode: null,
    category: 'Rings',
    collection: 'Home page',
    netWeight: null,
    makingCharge: null,
    silverRate: null,
    stock: 0,
    vendor: null,
    productType: null,
    description: null,
    compareAtPrice: null,
    image: null,
    images: null,
    chargeOnTax: true,
    shopifyId: null,
    shopifyStatus: null,
    status: null,
    ...overrides,
  }
}

/**
 * In-memory stand-in for the products table. insert() enforces the same
 * unique SKU index (products_sku_idx) the real database does, so a pull that
 * tries to insert a duplicate SKU fails exactly like production did.
 */
function fakeCatalog(initial: CatalogRow[]) {
  const rows: CatalogRow[] = [...initial]
  const insertCalls: CatalogInsertValues[] = []
  const io: CatalogApplyIo = {
    async insert(values) {
      insertCalls.push(values)
      if (rows.some((r) => r.sku === values.sku)) {
        throw new Error('duplicate key value violates unique constraint "products_sku_idx"')
      }
      const row: CatalogRow = {
        id: values.id,
        sku: values.sku,
        name: values.name,
        barcode: values.barcode ?? null,
        category: values.category,
        collection: values.collection ?? null,
        netWeight: values.netWeight ?? null,
        makingCharge: values.makingCharge ?? null,
        silverRate: values.silverRate ?? null,
        stock: values.stock ?? null,
        vendor: values.vendor ?? null,
        productType: values.productType ?? null,
        description: values.description ?? null,
        compareAtPrice: values.compareAtPrice ?? null,
        image: values.image ?? null,
        images: values.images ?? null,
        chargeOnTax: values.chargeOnTax ?? true,
        shopifyId: values.shopifyId ?? null,
        shopifyStatus: values.shopifyStatus ?? null,
        status: values.status ?? null,
      }
      rows.push(row)
      return row
    },
    async update(existing, patch) {
      Object.assign(existing, patch)
    },
  }
  return { rows, insertCalls, io }
}

describe('applyLiveCatalog (product pull SKU reconciliation)', () => {
  test('duplicate live SKU on a fresh database updates instead of colliding on products_sku_idx', async () => {
    // The store's real shape: SLR-001 on both "nose Pins" and
    // "Silver Solitaire Ring", plus an unrelated product.
    const nosePins = liveProduct({ id: 8230444335197, title: 'nose Pins', sku: 'SLR-001' })
    const solitaire = liveProduct({ id: 8201324658781, title: 'Silver Solitaire Ring', sku: 'SLR-001' })
    const other = liveProduct({ id: 99, title: 'Silver Chain', sku: 'SLC-001' })

    const { rows, insertCalls, io } = fakeCatalog([])
    const result = await shopify.applyLiveCatalog([nosePins, solitaire, other], [], 92.8, io)

    // Before the fix this threw: first insert succeeded, the second SLR-001
    // insert hit the unique index and aborted the entire import.
    assert.deepEqual(result, { created: 2, updated: 1 })
    assert.equal(insertCalls.length, 2, 'only one insert per distinct SKU')

    const dupRows = rows.filter((r) => r.sku === 'SLR-001')
    assert.equal(dupRows.length, 1, 'duplicate SKU collapses onto a single local row')
    // The second live product wins the row — the same behaviour a warm
    // database always had through the update path.
    assert.equal(dupRows[0].name, 'Silver Solitaire Ring')
    assert.equal(dupRows[0].shopifyId, '8201324658781')
    assert.equal(rows.find((r) => r.sku === 'SLC-001')?.name, 'Silver Chain')
  })

  test('existing SKU takes the update path: no insert, pricing preserved', async () => {
    const existing = localRow({
      id: 'row-abc',
      sku: 'ABC-1',
      name: 'Old Name',
      netWeight: 10,
      makingCharge: 20,
      silverRate: 92.8,
    })
    const { rows, insertCalls, io } = fakeCatalog([existing])
    const live = liveProduct({ id: 77, title: 'New Name', sku: 'abc-1', price: '2500' })

    const result = await shopify.applyLiveCatalog([live], [existing], 92.8, io)

    assert.deepEqual(result, { created: 0, updated: 1 })
    assert.equal(insertCalls.length, 0, 'an existing SKU must never insert')
    assert.equal(existing.name, 'New Name')
    assert.equal(existing.shopifyId, '77')
    assert.equal(existing.shopifyStatus, 'synced')
    // Existing weight means the pricing pass is skipped — local pricing wins.
    assert.equal(existing.netWeight, 10)
    assert.equal(existing.makingCharge, 20)
    assert.equal(rows.length, 1)
  })

  test('fresh insert carries the fields the sync relies on', async () => {
    const { rows, io } = fakeCatalog([])
    const live = liveProduct({
      id: 4242,
      title: 'Fresh Pendant',
      sku: 'NEW-1',
      productType: 'Pendants',
      collection: 'Rings',
      barcode: '123456789',
      chargeOnTax: false,
      price: '1500',
    })

    const result = await shopify.applyLiveCatalog([live], [], 92.8, io)

    assert.deepEqual(result, { created: 1, updated: 0 })
    assert.equal(rows.length, 1)
    const row = rows[0]
    assert.equal(row.name, 'Fresh Pendant')
    assert.equal(row.sku, 'NEW-1')
    assert.equal(row.shopifyId, '4242')
    assert.equal(row.shopifyStatus, 'synced')
    assert.equal(row.status, 'active')
    assert.equal(row.collection, 'Rings')
    assert.equal(row.barcode, '123456789')
    assert.equal(row.chargeOnTax, false)
    // backComputePricing turns the price into a net weight at the live rate.
    assert.equal(typeof row.netWeight, 'number')
    assert.ok((row.netWeight as number) > 0)
  })
})
