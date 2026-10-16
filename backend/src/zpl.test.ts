import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ZPL_DOTS_PER_MM,
  zplDimensionError,
  zplEscape,
  zplLabel,
  renderZpl,
  zplOptionsForPreset,
} from './zpl'

const product = {
  name: 'Diamond Ring',
  sku: 'SKU-1',
  barcode: 'OLABC12345',
  price: 1234.5,
  weight: 3.2,
  category: 'Rings',
}

// 16. Print escaping / injection resistance -----------------------------------

test('zplEscape neutralises the ZPL command introducers', () => {
  assert.equal(zplEscape('Acme ^FS^XZ'), 'Acme \\5EFS\\5EXZ')
  assert.equal(zplEscape('tilde ~JR'), 'tilde \\7EJR')
  assert.equal(zplEscape('back\\slash'), 'back\\5Cslash')
})

test('zplEscape replaces non-ASCII and control characters so the byte stream stays safe', () => {
  assert.equal(zplEscape('Ring\u00b7'), 'Ring?')
  assert.equal(zplEscape('a\nb\tc'), 'a?b?c')
  assert.equal(zplEscape(null), '')
})

test('a malicious product name cannot inject a ZPL command', () => {
  const zpl = zplLabel({ ...product, name: 'Evil^FS^XZ^XA' }, { width: 50, height: 40 })
  assert.ok(zpl)
  // The only real ^XZ is the renderer's own closing marker at the very end.
  assert.equal((zpl!.match(/\^XZ/g) ?? []).length, 1)
  assert.equal((zpl!.match(/\^FS/g) ?? []).length, (zpl!.match(/\^FD/g) ?? []).length)
  assert.ok(zpl!.includes('Evil\\5EFS\\5EXZ\\5EXA'))
})

// 17. Valid, scannable payloads ----------------------------------------------

test('the QR symbol uses the reference ^BQN command and carries the identifier', () => {
  const zpl = zplLabel(product, { width: 50, height: 40, symbology: 'qr' })
  assert.ok(zpl)
  assert.match(zpl!, /\^BQN,2,\d+/)
  assert.ok(zpl!.includes('^FDLA,OLABC12345^FS'))
})

test('the linear option uses Code 128 with the exact same identifier', () => {
  const zpl = zplLabel(product, { width: 50, height: 40, symbology: 'code128' })
  assert.ok(zpl)
  assert.match(zpl!, /\^BCN,\d+,Y,N,N/)
  assert.ok(zpl!.includes('^FDOLABC12345^FS'))
  assert.ok(!zpl!.includes('^BQN'))
})

test('a product without a barcode falls back to its SKU in the symbol', () => {
  const zpl = zplLabel({ ...product, barcode: undefined }, { width: 50, height: 25 })
  assert.ok(zpl)
  assert.ok(zpl!.includes('^FDLA,SKU-1^FS'))
})

// 13/15. Dimensions + printer integration ------------------------------------

test('label width and length commands reflect the physical size at 203 dpi', () => {
  for (const [w, h] of [
    [50, 40],
    [50, 25],
    [50, 10],
    [35, 22],
  ]) {
    const zpl = zplLabel(product, { width: w, height: h })
    assert.ok(zpl)
    assert.ok(zpl!.includes(`^PW${w * ZPL_DOTS_PER_MM}`), `${w}x${h} width`)
    assert.ok(zpl!.includes(`^LL${h * ZPL_DOTS_PER_MM}`), `${w}x${h} length`)
  }
})

test('zplDimensionError rejects impossible sizes', () => {
  assert.match(zplDimensionError(0, 40) ?? '', /positive/)
  assert.match(zplDimensionError(50, -1) ?? '', /positive/)
  assert.match(zplDimensionError(500, 40) ?? '', /200 mm or less/)
  assert.equal(zplDimensionError(50, 40), null)
})

test('an invalid size renders nothing rather than a broken stream', () => {
  assert.equal(zplLabel(product, { width: 0, height: 40 }), null)
  assert.equal(renderZpl([product], { width: 9999, height: 40 }), '')
})

test('copies are delegated to the printer with ^PQ', () => {
  const zpl = zplLabel(product, { width: 50, height: 40, copies: 5 })
  assert.ok(zpl)
  assert.ok(zpl!.includes('^PQ5,0,1,Y'))
})

// 9/10. Individual + bulk printing -------------------------------------------

test('renderZpl emits exactly one label block per product', () => {
  const many = Array.from({ length: 4 }, (_, i) => ({ ...product, barcode: `OL${i}00000000` }))
  const zpl = renderZpl(many, { width: 50, height: 25 })
  assert.equal((zpl.match(/\^XA/g) ?? []).length, 4)
  assert.equal((zpl.match(/\^XZ/g) ?? []).length, 4)
})

test('renderZpl returns an empty string when there is nothing to print', () => {
  assert.equal(renderZpl([], { width: 50, height: 40 }), '')
})

test('zplOptionsForPreset resolves the physical size from the shared preset list', () => {
  assert.deepEqual(
    (({ width, height }) => ({ width, height }))(zplOptionsForPreset('label-50x10')),
    { width: 50, height: 10 },
  )
  assert.deepEqual(
    (({ width, height }) => ({ width, height }))(zplOptionsForPreset('label-35x22')),
    { width: 35, height: 22 },
  )
  // Unknown key falls back to the default size rather than throwing.
  assert.deepEqual(
    (({ width, height }) => ({ width, height }))(zplOptionsForPreset('nope')),
    { width: 50, height: 40 },
  )
})

test('missing optional fields never produce an empty ZPL field', () => {
  const zpl = zplLabel({ name: '', sku: '', price: 0 }, { width: 50, height: 25, brand: '' })
  assert.ok(zpl)
  // An empty brand is skipped entirely rather than emitting `^FD^FS`, and the
  // name still falls back to a placeholder.
  assert.ok(!zpl!.includes('^FD^FS'))
  assert.ok(zpl!.includes('^FDProduct^FS'))
})
