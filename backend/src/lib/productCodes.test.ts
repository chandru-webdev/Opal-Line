import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  DEFAULT_SKU_FORMAT,
  categoryCode,
  ean13CheckDigit,
  generateBarcode,
  generateSku,
  generateVariantSku,
  maxSequence,
  normalizedCodeSettings,
  renderSku,
} from './productCodes'

test('defaults reproduce the house style SLV-RNG-00001', () => {
  assert.equal(generateSku([], 'Rings'), 'SLV-RNG-00001')
  assert.equal(generateSku(['SLV-RNG-00003'], 'Rings'), 'SLV-RNG-00004')
  assert.equal(renderSku(null, 'Rings', 7), 'SLV-RNG-00007')
  assert.equal(DEFAULT_SKU_FORMAT, '{PREFIX}-{CATEGORY}-{SEQ}')
})

test('configured prefix, suffix and sequence length drive the format', () => {
  const cfg = { skuPrefix: 'opal', skuSuffix: 'in', skuFormat: '{PREFIX}-{CATEGORY}-{SEQ}{SUFFIX}', skuSeqLength: 3 }
  assert.equal(renderSku(cfg, 'Rings', 42), 'OPAL-RNG-042IN')
  // Prefix/suffix are upper-cased; a format without {SEQ} falls back to the default.
  assert.equal(normalizedCodeSettings({ skuFormat: 'whatever' }).skuFormat, DEFAULT_SKU_FORMAT)
  assert.equal(renderSku({ skuPrefix: 'abc', skuFormat: '{PREFIX}-{SEQ}' }, 'Chains', 9), 'ABC-00009')
})

test('legacy house-style SKUs keep their sequence across the template move', () => {
  // Old fixed-format rows plus one already on the new format.
  const existing = ['SLV-RNG-00021', 'SLV-GEN-00099', 'BGL-CUF-7']
  assert.equal(maxSequence(existing), 99)
  assert.equal(generateSku(existing, 'Rings'), 'SLV-RNG-00100')
})

test('generation never collides with existing codes', () => {
  assert.equal(generateSku(['SLV-RNG-00001', 'SLV-RNG-00002', 'SLV-RNG-00004'], 'Rings'), 'SLV-RNG-00005')
  // Case-insensitive collisions count too.
  assert.equal(generateSku(['slv-rng-00003'], 'Rings'), 'SLV-RNG-00004')
})

test('category codes match the house map and fall back to letters', () => {
  assert.equal(categoryCode('Rings'), 'RNG')
  assert.equal(categoryCode('Silver jewels'), 'GEN')
  assert.equal(categoryCode('Toe Rings'), 'TRG')
  assert.equal(categoryCode('Pashmina Shawls'), 'PAS')
  assert.equal(categoryCode('123'), 'GEN')
})

test('EAN-13 check digit matches the published algorithm', () => {
  // 4006381333931 is the classic EAN-13 example (check digit 1).
  assert.equal(ean13CheckDigit('400638133393'), 1)
  // 890123456789 → weighted sum 130 → check digit 0.
  assert.equal(ean13CheckDigit('890123456789'), 0)
})

test('barcodes are valid EAN-13 under the configured prefix and never repeat', () => {
  const code = generateBarcode([])
  assert.match(code, /^\d{13}$/)
  assert.ok(code.startsWith('890'))
  assert.equal(ean13CheckDigit(code.slice(0, 12)), Number(code[12]))

  const two = generateBarcode([code])
  assert.notEqual(two, code)
  assert.ok(two.startsWith('890'))
  assert.equal(ean13CheckDigit(two.slice(0, 12)), Number(two[12]))

  // A custom prefix is honoured and the sequence continues past used codes.
  const custom = generateBarcode(['7770000000005'], { barcodePrefix: '777' })
  assert.ok(custom.startsWith('777'))
  assert.match(custom, /^\d{13}$/)
  assert.equal(ean13CheckDigit(custom.slice(0, 12)), Number(custom[12]))
})

test('variant SKUs join the parent SKU with per-value codes and de-duplicate', () => {
  assert.equal(generateVariantSku('SLV-RNG-00001', ['Small', 'Red'], []), 'SLV-RNG-00001-SMA-RED')
  // Duplicate of an existing code bumps a numeric tail.
  assert.equal(
    generateVariantSku('SLV-RNG-00001', ['Small', 'Red'], ['SLV-RNG-00001-SMA-RED']),
    'SLV-RNG-00001-SMA-RED-2',
  )
})
