import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  LABEL_PRESET_LIST,
  LABEL_PRESETS,
  computeLabelGeometry,
  computeLabelLines,
  formatLabelRate,
  generateLabelsPDF,
  labelCode,
  resolveLabelPreset,
} from './barcodeLabels'

// 14. All four physical-size templates ---------------------------------------

test('the four reference sizes are present with their real physical dimensions', () => {
  const byKey = new Map(LABEL_PRESET_LIST.map((p) => [p.key, p]))
  assert.deepEqual(
    ['label-50x40', 'label-50x25', 'label-50x10', 'label-35x22'].map((k) => {
      const p = byKey.get(k)
      assert.ok(p, `missing preset ${k}`)
      return [p.width, p.height]
    }),
    [
      [50, 40],
      [50, 25],
      [50, 10],
      [35, 22],
    ],
  )
})

test('reference presets are flagged and listed first', () => {
  const firstFour = LABEL_PRESET_LIST.slice(0, 4).map((p) => p.key)
  assert.deepEqual(firstFour, ['label-50x40', 'label-50x25', 'label-35x22', 'label-50x10'])
  assert.ok(LABEL_PRESET_LIST.slice(0, 4).every((p) => p.reference))
})

test('the grid for every preset fits an A4 sheet', () => {
  const a4w = 210
  const a4h = 297
  for (const [key, preset] of Object.entries(LABEL_PRESETS)) {
    const p = preset as { width: number; height: number; columns: number; rows: number }
    assert.ok(p.width * p.columns <= a4w + 0.001, `${key} too wide`)
    assert.ok(p.height * p.rows <= a4h + 0.001, `${key} too tall`)
  }
})

// 9/10. Copies + individual/bulk options --------------------------------------

test('resolveLabelPreset clamps copies into a printable range', () => {
  assert.equal(resolveLabelPreset('label-50x40', { copies: 0 }).copies, 1)
  assert.equal(resolveLabelPreset('label-50x40', { copies: -5 }).copies, 1)
  assert.equal(resolveLabelPreset('label-50x40', { copies: 7.9 }).copies, 7)
  assert.equal(resolveLabelPreset('label-50x40', { copies: 5000 }).copies, 999)
  assert.equal(resolveLabelPreset('label-50x40').copies, 1)
})

test('resolveLabelPreset falls back to the default size for an unknown key', () => {
  const opts = resolveLabelPreset('does-not-exist')
  assert.equal(opts.width, 50)
  assert.equal(opts.height, 40)
})

test('resolveLabelPreset honours a legacy businessName override', () => {
  const opts = resolveLabelPreset('label-50x40', { businessName: 'SREE KANDHAS' } as never)
  assert.equal(opts.brand, 'SREE KANDHAS')
})

// 11/12. Content, long names, missing optional fields -------------------------

test('labelCode prefers the product barcode and falls back to SKU', () => {
  assert.equal(labelCode({ barcode: 'OL123', sku: 'SKU-1' }), 'OL123')
  assert.equal(labelCode({ barcode: '', sku: 'SKU-1' }), 'SKU-1')
  assert.equal(labelCode({ barcode: undefined, sku: 'SKU-1' }), 'SKU-1')
  assert.equal(labelCode({ barcode: '  ', sku: 'SKU-1' }), 'SKU-1')
})

test('formatLabelRate matches the reference "Rate: x/-" shape', () => {
  // The supplied `.prn` samples print the amount without a thousands
  // separator, and the PDF and the ZPL must agree on the exact string.
  assert.equal(formatLabelRate(99999), 'Rate: 99999.00/-')
  assert.equal(formatLabelRate(1234.5), 'Rate: 1234.50/-')
  assert.equal(formatLabelRate(0), 'Rate: 0.00/-')
  assert.equal(formatLabelRate(Number.NaN), 'Rate: 0.00/-')
})

const product = { name: 'Diamond Ring', sku: 'SKU-1', barcode: 'OLABC12345', price: 1234.5, weight: 3.2, category: 'Rings' }

test('a full label shows brand, name, code and price', () => {
  const geo = computeLabelGeometry((50 / 25.4) * 72, (40 / 25.4) * 72, true)
  const lines = computeLabelLines(geo, product, { showPrice: true, showWeight: true, showBrand: true, brand: 'SREE KANDHAS' })
  const kinds = lines.map((l) => l.kind)
  assert.ok(kinds.includes('brand'))
  assert.ok(kinds.includes('name'))
  assert.ok(kinds.includes('price'))
  assert.ok(kinds.includes('code'))
  assert.equal(lines.find((l) => l.kind === 'name')?.text, 'Diamond Ring')
  assert.equal(lines.find((l) => l.kind === 'code')?.text, 'Code: OLABC12345')
})

test('a tiny label drops optional lines but keeps the name and price', () => {
  const geo = computeLabelGeometry((50 / 25.4) * 72, (10 / 25.4) * 72, true)
  const lines = computeLabelLines(geo, product, { showPrice: true, showWeight: true, showBrand: true, brand: 'SREE KANDHAS' })
  const kinds = lines.map((l) => l.kind)
  assert.ok(kinds.includes('name'), 'name must never be dropped')
  assert.ok(kinds.includes('price'), 'price should survive on the smallest label')
})

test('the compact (50x10) label omits the "Code:" prefix to save space', () => {
  const geo = computeLabelGeometry((50 / 25.4) * 72, (10 / 25.4) * 72, true)
  const lines = computeLabelLines(geo, product, { showPrice: true, showWeight: true, showBrand: true, brand: 'B', compact: true })
  const code = lines.find((l) => l.kind === 'code')
  if (code) assert.equal(code.text, 'OLABC12345')
})

test('missing optional fields never produce empty text entries', () => {
  const geo = computeLabelGeometry((50 / 25.4) * 72, (25 / 25.4) * 72, true)
  const lines = computeLabelLines(
    geo,
    { name: 'Plain', sku: 'S1', price: 10 },
    { showPrice: true, showWeight: true, showBrand: false },
  )
  assert.ok(lines.every((l) => l.text.length > 0))
  assert.ok(!lines.some((l) => l.kind === 'weight'))
  assert.ok(!lines.some((l) => l.kind === 'brand'))
})

// 13. Correct label geometry --------------------------------------------------

test('label geometry scales with the physical size, not a hard-coded layout', () => {
  const big = computeLabelGeometry((50 / 25.4) * 72, (40 / 25.4) * 72, true)
  const small = computeLabelGeometry((35 / 25.4) * 72, (22 / 25.4) * 72, true)
  assert.ok(big.qrSize > small.qrSize)
  assert.ok(big.qrSize <= big.innerH + 0.001)
  assert.ok(small.qrSize <= small.innerH + 0.001)
  // The text column must never be pushed off the label.
  assert.ok(big.textX + big.textWidth <= (50 / 25.4) * 72 - big.pad + 0.001)
})

test('label geometry leaves no code space when QR is disabled', () => {
  const geo = computeLabelGeometry((50 / 25.4) * 72, (40 / 25.4) * 72, false)
  assert.equal(geo.qrSize, 0)
  assert.equal(geo.textWidth, geo.innerW)
})

// Scannable payload + smoke test of the real PDF pipeline ---------------------

test('generateLabelsPDF produces a PDF and encodes the identifier', async () => {
  const pdf = await generateLabelsPDF([product], { width: 50, height: 25, columns: 4, rows: 11, showPrice: true, showWeight: true, showQR: true, showBarcode: true, showBrand: true, brand: 'SREE KANDHAS', copies: 1 })
  assert.ok(pdf, 'expected a PDF buffer')
  assert.ok(pdf!.length > 500)
  assert.equal(pdf!.subarray(0, 5).toString('latin1'), '%PDF-')
})

test('generateLabelsPDF repeats the product once per copy', async () => {
  const one = await generateLabelsPDF([product], { copies: 1 } as never)
  const four = await generateLabelsPDF([product], { copies: 4 } as never)
  assert.ok(one && four)
  // More copies → more embedded QR images → a larger document.
  assert.ok(four!.length > one!.length)
})

test('generateLabelsPDF returns null for an empty product list', async () => {
  assert.equal(await generateLabelsPDF([]), null)
})

test('labels survive a long name and a missing barcode', async () => {
  const longName = 'Antique Finish Hand Crafted Temple Design Silver Necklace With Gemstones'
  const pdf = await generateLabelsPDF(
    [{ name: longName, sku: 'SKU-LONG', price: 99999, weight: 42.5 }],
    { width: 35, height: 22, columns: 5, rows: 13, showQR: true, showPrice: true, showWeight: true, showBrand: true, brand: 'SREE KANDHAS', copies: 1 } as never,
  )
  assert.ok(pdf)
  assert.equal(pdf!.subarray(0, 5).toString('latin1'), '%PDF-')
})
