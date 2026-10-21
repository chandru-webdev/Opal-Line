/**
 * Draft-order line mapping for manual orders: a line carrying a variantId
 * must target that exact Shopify variant (gid form), so multi-variant
 * products sync the right SKU/price; lines without one keep the historic
 * title/sku/price shape that flat products have always sent.
 *
 * No network and no database: DATABASE_URL is cleared before ./shopify loads
 * so importing it never opens a connection.
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import 'dotenv/config'

delete process.env.DATABASE_URL

import { buildDraftOrderLineItems, toShopifyVariantGid } from './shopify'

describe('toShopifyVariantGid', () => {
  test('wraps a numeric id in the gid form', () => {
    assert.equal(toShopifyVariantGid(123456), 'gid://shopify/ProductVariant/123456')
  })

  test('passes an existing gid through untouched', () => {
    assert.equal(toShopifyVariantGid('gid://shopify/ProductVariant/99'), 'gid://shopify/ProductVariant/99')
  })

  test('accepts a numeric string id', () => {
    assert.equal(toShopifyVariantGid('42'), 'gid://shopify/ProductVariant/42')
  })
})

describe('buildDraftOrderLineItems', () => {
  test('flat lines keep the title/sku/price shape', () => {
    const [line] = buildDraftOrderLineItems([{ title: 'Silver Ring', quantity: 2, price: 1200, sku: 'RING-42' }])
    assert.deepEqual(line, {
      title: 'Silver Ring',
      quantity: 2,
      sku: 'RING-42',
      originalUnitPrice: '1200.00',
    })
    assert.ok(!('variantId' in line))
  })

  test('a variant line targets the exact Shopify variant', () => {
    const [line] = buildDraftOrderLineItems([
      { title: 'Silver Ring — 16in / Gold', quantity: 1, price: 1500, sku: 'RING-42-GOLD', variantId: 777 },
    ])
    assert.equal(line.variantId, 'gid://shopify/ProductVariant/777')
    assert.equal(line.sku, 'RING-42-GOLD')
    assert.equal(line.originalUnitPrice, '1500.00')
  })

  test('an empty variantId is treated as absent', () => {
    const [line] = buildDraftOrderLineItems([{ title: 'Chain', quantity: 1, price: 900, sku: 'CH-1', variantId: '  ' }])
    assert.ok(!('variantId' in line))
  })

  test('lines without a title or quantity are dropped', () => {
    const lines = buildDraftOrderLineItems([
      { title: '', quantity: 1, price: 100 },
      { title: 'Ring', quantity: 0, price: 100 },
      { title: 'Ring', quantity: 1, price: 100 },
    ])
    assert.equal(lines.length, 1)
  })

  test('a non-finite price falls back to 0.00', () => {
    const [line] = buildDraftOrderLineItems([{ title: 'Ring', quantity: 1, price: null }])
    assert.equal(line.originalUnitPrice, '0.00')
  })
})
