import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeGstin,
  isValidGstin,
  normalizeEmail,
  isValidEmail,
  validateSupplierInput,
} from './validation'

describe('normalizeGstin', () => {
  test('trims and upper-cases', () => {
    assert.equal(normalizeGstin(' 27aaaco1234f1z5 '), '27AAACO1234F1Z5')
  })

  test('empty and null become empty', () => {
    assert.equal(normalizeGstin(''), '')
    assert.equal(normalizeGstin(null), '')
    assert.equal(normalizeGstin(undefined), '')
  })
})

describe('isValidGstin', () => {
  test('accepts well-formed GSTINs', () => {
    assert.equal(isValidGstin('27AAACO1234F1Z5'), true)
    assert.equal(isValidGstin('07AABCU9603R1ZM'), true)
  })

  test('accepts a lower-case GSTIN after normalising', () => {
    assert.equal(isValidGstin('27aaaco1234f1z5'), true)
  })

  test('accepts empty because GSTIN is optional', () => {
    assert.equal(isValidGstin(''), true)
    assert.equal(isValidGstin(null), true)
  })

  test('rejects malformed values', () => {
    assert.equal(isValidGstin('27AAACO1234F1Z'), false)
    assert.equal(isValidGstin('AAACO1234F1Z5'), false)
    assert.equal(isValidGstin('27AAACO1234F1Z55'), false)
    assert.equal(isValidGstin('27AAACO1234F1Y5'), false)
  })
})

describe('isValidEmail', () => {
  test('accepts a plain address', () => {
    assert.equal(isValidEmail('contact@goyal.co.in'), true)
  })

  test('empty is allowed', () => {
    assert.equal(isValidEmail(''), true)
    assert.equal(isValidEmail(null), true)
  })

  test('rejects malformed addresses', () => {
    assert.equal(isValidEmail('not-an-email'), false)
    assert.equal(isValidEmail('a@b'), false)
    assert.equal(isValidEmail('a b@c.com'), false)
  })

  test('normalizeEmail trims', () => {
    assert.equal(normalizeEmail('  a@b.co '), 'a@b.co')
  })
})

describe('validateSupplierInput', () => {
  test('name is required by default', () => {
    assert.equal(validateSupplierInput({ name: '' }), 'Supplier name is required')
    assert.equal(validateSupplierInput({ name: '   ' }), 'Supplier name is required')
    assert.equal(validateSupplierInput({}), 'Supplier name is required')
  })

  test('requireName false allows a status-only update', () => {
    assert.equal(validateSupplierInput({}, { requireName: false }), null)
  })

  test('a complete, valid payload passes', () => {
    assert.equal(
      validateSupplierInput({ name: 'Goyal Silver House', email: 'goyal@example.com', gstin: '27AAACO1234F1Z5' }),
      null,
    )
  })

  test('a malformed email is rejected with a friendly message', () => {
    assert.equal(validateSupplierInput({ name: 'X', email: 'not-an-email' }), 'Enter a valid email address')
  })

  test('a malformed GSTIN is rejected with a friendly message', () => {
    assert.equal(validateSupplierInput({ name: 'X', gstin: 'ABC' }), 'Enter a valid 15-character GSTIN')
  })

  test('empty email and GSTIN are allowed', () => {
    assert.equal(validateSupplierInput({ name: 'X', email: '', gstin: '' }), null)
  })
})
