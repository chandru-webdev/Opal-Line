import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BARCODE_MAX_LENGTH,
  BARCODE_PREFIX,
  barcodeFormatError,
  duplicateBarcodeMessage,
  duplicateScanMessage,
  inactiveProductMessage,
  isValidBarcode,
  makeBarcode,
  newBarcodeSeed,
  normalizeBarcode,
  normalizeScanCode,
  scanCodeError,
} from './barcode'

// 1. Unique, stable generation ------------------------------------------------

test('makeBarcode is deterministic for a given seed (idempotent generation)', () => {
  const a = makeBarcode('product-123')
  const b = makeBarcode('product-123')
  assert.equal(a, b)
  // Repeat execution must not produce a different value — this is what makes a
  // backfill safe to re-run.
  assert.equal(makeBarcode('product-123'), a)
})

test('makeBarcode produces distinct codes for distinct seeds', () => {
  const seen = new Set<string>()
  for (let i = 0; i < 500; i++) seen.add(makeBarcode(`seed-${i}`))
  assert.equal(seen.size, 500)
})

test('generated barcodes are always valid and carry the store prefix', () => {
  for (let i = 0; i < 200; i++) {
    const code = makeBarcode(newBarcodeSeed())
    assert.ok(code.startsWith(BARCODE_PREFIX), code)
    assert.equal(barcodeFormatError(code), null, code)
    assert.ok(isValidBarcode(code))
  }
})

test('newBarcodeSeed returns a fresh value each call', () => {
  assert.notEqual(newBarcodeSeed(), newBarcodeSeed())
})

// 2. Validation / normalisation ----------------------------------------------

test('normalizeBarcode trims surrounding whitespace but preserves case and legacy values', () => {
  assert.equal(normalizeBarcode('  W12345 '), 'W12345')
  assert.equal(normalizeBarcode('8901234567210'), '8901234567210')
  assert.equal(normalizeBarcode(null), '')
  assert.equal(normalizeBarcode(undefined), '')
})

test('barcodeFormatError rejects empty, too short, too long and illegal values', () => {
  assert.equal(barcodeFormatError(''), 'Barcode cannot be empty')
  assert.match(barcodeFormatError('ab') ?? '', /at least/)
  assert.match(barcodeFormatError('a'.repeat(BARCODE_MAX_LENGTH + 1)) ?? '', /at most/)
  assert.match(barcodeFormatError('has space') ?? '', /letters, numbers/)
  assert.match(barcodeFormatError('-leading') ?? '', /letters, numbers/)
  assert.match(barcodeFormatError('tab\tchar') ?? '', /letters, numbers/)
})

test('barcodeFormatError accepts numeric, alphanumeric and separator forms', () => {
  for (const value of ['001', 'W12345', '8901234567210', 'SLV-RNG_1.2']) {
    assert.equal(barcodeFormatError(value), null, value)
  }
})

// 6/8. Scanner input normalisation + exact lookup -----------------------------

test('normalizeScanCode strips keyboard-wedge CR/LF, spaces and control characters', () => {
  assert.equal(normalizeScanCode('  OL1A2B3C4D5E\r\n'), 'OL1A2B3C4D5E')
  assert.equal(normalizeScanCode('8901\t2345'), '89012345')
  assert.equal(normalizeScanCode('\u0000OL123\u007f'), 'OL123')
  assert.equal(normalizeScanCode(null), '')
})

test('normalizeScanCode is exact — it never rewrites characters', () => {
  // No case folding, no fuzzy prefix/suffix handling: the resolved code must be
  // byte-for-byte what was scanned.
  assert.equal(normalizeScanCode('ol-abc'), 'ol-abc')
  assert.notEqual(normalizeScanCode('OL123'), normalizeScanCode('OL1234'))
})

test('scanCodeError rejects blank and single-character input', () => {
  assert.match(scanCodeError('') ?? '', /required/)
  assert.match(scanCodeError('   ') ?? '', /required/)
  assert.match(scanCodeError('x') ?? '', /too short/)
  assert.equal(scanCodeError('OL123'), null)
})

test('scan codes are capped so an over-long paste cannot be used as input', () => {
  assert.equal(normalizeScanCode('9'.repeat(500)).length, 128)
})

// Duplicate / inactive messaging ---------------------------------------------

test('duplicate and inactive messages name the problem without leaking internals', () => {
  assert.match(duplicateBarcodeMessage('OL123'), /OL123/)
  assert.match(duplicateBarcodeMessage('OL123'), /already assigned/)
  assert.equal(duplicateScanMessage(), 'That code matches more than one product — fix the duplicate barcode first')
  assert.match(inactiveProductMessage('Silver Ring', 'inactive'), /Silver Ring/)
  assert.match(inactiveProductMessage('Silver Ring', 'inactive'), /inactive/)
  assert.match(inactiveProductMessage('Silver Ring', 'archived'), /archived/)
})
