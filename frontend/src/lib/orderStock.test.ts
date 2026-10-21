import test from 'node:test'
import assert from 'node:assert/strict'
import {
  computeLineStockErrors,
  formatStockShortfall,
  parseInsufficientStockError,
  stockErrorsFromApiError,
  type StockValidationLine,
} from './orderStock'

/**
 * The Manual Order modal shows stock shortfalls under the offending Qty field.
 * These tests pin the pure helpers behind that behaviour: the live per-line
 * check against the loaded catalog, and the mapping of the order endpoints'
 * own "Insufficient stock for SKU …" response back onto a line.
 */

const line = (over: Partial<StockValidationLine> = {}): StockValidationLine => ({
  key: 'li-1',
  productId: 'p-1',
  sku: 'RING-42',
  qty: 1,
  ...over,
})

test('formatStockShortfall matches the modal message', () => {
  assert.equal(formatStockShortfall(33, 100), 'Only 33 units available. You entered 100.')
})

test('computeLineStockErrors: qty within stock produces no error', () => {
  const errs = computeLineStockErrors([line({ qty: 3 })], new Map([['p-1', 3]]))
  assert.deepEqual(errs, {})
})

test('computeLineStockErrors: exceeding stock reports the line with the example wording', () => {
  const errs = computeLineStockErrors([line({ qty: 100 })], new Map([['p-1', 33]]))
  assert.deepEqual(errs, { 'li-1': 'Only 33 units available. You entered 100.' })
})

test('computeLineStockErrors: zero stock blocks any positive quantity', () => {
  const errs = computeLineStockErrors([line({ qty: 1 })], new Map([['p-1', 0]]))
  assert.deepEqual(errs, { 'li-1': 'Only 0 units available. You entered 1.' })
})

test('computeLineStockErrors: lines are independent across products', () => {
  const errs = computeLineStockErrors(
    [
      line({ key: 'li-1', productId: 'p-1', sku: 'RING-42', qty: 2 }),
      line({ key: 'li-2', productId: 'p-2', sku: 'CHAIN-7', qty: 5 }),
      line({ key: 'li-3', productId: 'p-3', sku: 'BANGLE-9', qty: 1 }),
    ],
    new Map([
      ['p-1', 10],
      ['p-2', 4],
      ['p-3', 1],
    ]),
  )
  assert.deepEqual(errs, { 'li-2': 'Only 4 units available. You entered 5.' })
})

test('computeLineStockErrors: duplicate products consume stock line by line', () => {
  const errs = computeLineStockErrors(
    [
      line({ key: 'li-1', qty: 4 }),
      line({ key: 'li-2', qty: 4 }),
    ],
    new Map([['p-1', 5]]),
  )
  assert.deepEqual(errs, { 'li-2': 'Only 1 units available. You entered 4.' })
})

test('computeLineStockErrors: lines without a known product are skipped', () => {
  const errs = computeLineStockErrors(
    [line({ productId: '', qty: 99 }), line({ key: 'li-2', productId: 'p-x', qty: 99 })],
    new Map([['p-1', 3]]),
  )
  assert.deepEqual(errs, {})
})

test('computeLineStockErrors: a variant line uses the variant stock, not the product rollup', () => {
  const errs = computeLineStockErrors(
    [line({ variantId: 'v-1', qty: 4, stock: 3 })],
    new Map([['p-1', 50]]),
  )
  assert.deepEqual(errs, { 'li-1': 'Only 3 units available. You entered 4.' })
})

test('computeLineStockErrors: variants of one product stock independently', () => {
  const errs = computeLineStockErrors(
    [
      line({ key: 'li-1', variantId: 'v-1', sku: 'R-16', qty: 3, stock: 3 }),
      line({ key: 'li-2', variantId: 'v-2', sku: 'R-18', qty: 3, stock: 7 }),
    ],
    new Map([['p-1', 10]]),
  )
  assert.deepEqual(errs, {})
})

test('computeLineStockErrors: duplicate variant lines share one variant pool', () => {
  const errs = computeLineStockErrors(
    [
      line({ key: 'li-1', variantId: 'v-1', qty: 2, stock: 3 }),
      line({ key: 'li-2', variantId: 'v-1', qty: 2, stock: 3 }),
    ],
    new Map([['p-1', 10]]),
  )
  assert.deepEqual(errs, { 'li-2': 'Only 1 units available. You entered 2.' })
})

test('computeLineStockErrors: a variant without stock falls back to the product rollup', () => {
  const errs = computeLineStockErrors(
    [line({ variantId: 'v-1', qty: 6, stock: undefined })],
    new Map([['p-1', 5]]),
  )
  assert.deepEqual(errs, { 'li-1': 'Only 5 units available. You entered 6.' })
})

test('parseInsufficientStockError: reads the order endpoint message', () => {
  const parsed = parseInsufficientStockError(
    'Insufficient stock for SKU RING-42 at this location: available 2, requested 5',
  )
  assert.deepEqual(parsed, { sku: 'RING-42', available: 2, requested: 5 })
})

test('parseInsufficientStockError: unrelated messages return null', () => {
  assert.equal(parseInsufficientStockError('Failed to create order'), null)
  assert.equal(parseInsufficientStockError(''), null)
})

test('stockErrorsFromApiError: maps the server response onto the matching line', () => {
  const err = new Error('Insufficient stock for SKU CHAIN-7 at this location: available 1, requested 9')
  const errs = stockErrorsFromApiError(err, [
    line({ key: 'li-1', sku: 'RING-42', qty: 2 }),
    line({ key: 'li-2', sku: 'CHAIN-7', qty: 9 }),
  ])
  assert.deepEqual(errs, { 'li-2': 'Only 1 units available. You entered 9.' })
})

test('stockErrorsFromApiError: falls back to the first line with the SKU', () => {
  const err = new Error('Insufficient stock for SKU RING-42 at this location: available 2, requested 5')
  const errs = stockErrorsFromApiError(err, [
    line({ key: 'li-1', qty: 5 }),
    line({ key: 'li-2', qty: 3 }),
  ])
  assert.deepEqual(errs, { 'li-1': 'Only 2 units available. You entered 5.' })
})

test('stockErrorsFromApiError: non-stock failures produce no line errors', () => {
  const errs = stockErrorsFromApiError(new Error('Failed to create order'), [line()])
  assert.deepEqual(errs, {})
})
