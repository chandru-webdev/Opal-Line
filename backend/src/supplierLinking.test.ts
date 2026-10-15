import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeSupplierName,
  findSupplierIdByName,
  planProductLinks,
  type SupplierRef,
} from './supplierLinking'

const suppliers: SupplierRef[] = [
  { id: 'SUP-1', name: 'Goyal Silver House' },
  { id: 'SUP-2', name: 'Mehta Bullion' },
  { id: 'SUP-3', name: 'Shree Metals' },
]

describe('normalizeSupplierName', () => {
  test('trims and lower-cases', () => {
    assert.equal(normalizeSupplierName('  Goyal Silver House '), 'goyal silver house')
  })

  test('null and undefined become empty', () => {
    assert.equal(normalizeSupplierName(null), '')
    assert.equal(normalizeSupplierName(undefined), '')
  })
})

describe('findSupplierIdByName', () => {
  test('matches ignoring case and surrounding space', () => {
    assert.equal(findSupplierIdByName('  goyal silver house ', suppliers), 'SUP-1')
    assert.equal(findSupplierIdByName('GOYAL SILVER HOUSE', suppliers), 'SUP-1')
  })

  test('returns null for an unknown name', () => {
    assert.equal(findSupplierIdByName('Unknown Traders', suppliers), null)
  })

  test('returns null for a blank name', () => {
    assert.equal(findSupplierIdByName('   ', suppliers), null)
    assert.equal(findSupplierIdByName(null, suppliers), null)
  })
})

describe('planProductLinks', () => {
  test('links matching products and reports unmatched names', () => {
    const { links, unmatched } = planProductLinks(
      [
        { id: 'P1', supplier: 'Goyal Silver House' },
        { id: 'P2', supplier: 'goyal silver house' },
        { id: 'P3', supplier: 'Mehta Bullion' },
        { id: 'P4', supplier: 'Totally Unknown' },
        { id: 'P5', supplier: '' },
        { id: 'P6', supplier: null },
      ],
      suppliers,
    )

    assert.deepEqual(
      links.sort((a, b) => a.productId.localeCompare(b.productId)),
      [
        { productId: 'P1', supplierId: 'SUP-1' },
        { productId: 'P2', supplierId: 'SUP-1' },
        { productId: 'P3', supplierId: 'SUP-2' },
      ],
    )
    assert.deepEqual(unmatched, ['Totally Unknown'])
  })

  test('unmatched names are distinct and sorted', () => {
    const { unmatched } = planProductLinks(
      [
        { id: 'P1', supplier: 'Zeta' },
        { id: 'P2', supplier: 'Zeta' },
        { id: 'P3', supplier: 'Alpha' },
      ],
      suppliers,
    )
    assert.deepEqual(unmatched, ['Alpha', 'Zeta'])
  })

  test('a blank or missing supplier never links', () => {
    const { links, unmatched } = planProductLinks(
      [
        { id: 'P1', supplier: '   ' },
        { id: 'P2', supplier: null },
      ],
      suppliers,
    )
    assert.deepEqual(links, [])
    assert.deepEqual(unmatched, [])
  })
})
