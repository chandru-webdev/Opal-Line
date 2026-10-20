import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  decideLockout,
  normalizeLockoutPolicy,
  LOCKOUT_THRESHOLD,
  LOCKOUT_DURATION_MS,
  LOCKOUT_MAX_THRESHOLD,
  LOCKOUT_MAX_DURATION_MINUTES,
} from './lockout'

const NOW = 1_000_000_000_000

describe('decideLockout', () => {
  test('threshold and window constants', () => {
    assert.equal(LOCKOUT_THRESHOLD, 5)
    assert.equal(LOCKOUT_DURATION_MS, 15 * 60 * 1000)
  })

  test('no stored state → fresh counter', () => {
    assert.deepEqual(decideLockout(0, undefined, NOW), { decision: 'reset', count: 1 })
  })

  test('few failures inside window stay allowed and count up', () => {
    assert.deepEqual(decideLockout(0, NOW - 1000, NOW), { decision: 'allowed', count: 1 })
    assert.deepEqual(decideLockout(1, NOW - 1000, NOW), { decision: 'allowed', count: 2 })
    assert.deepEqual(decideLockout(3, NOW - 1000, NOW), { decision: 'allowed', count: 4 })
  })

  test('the threshold-th failure inside the window locks', () => {
    const d = decideLockout(4, NOW - 1000, NOW)
    assert.equal(d.decision, 'locked')
    if (d.decision === 'locked') assert.equal(d.retryableAt, NOW - 1000 + LOCKOUT_DURATION_MS)
  })

  test('failures beyond the threshold stay locked', () => {
    assert.equal(decideLockout(9, NOW - 1000, NOW).decision, 'locked')
  })

  test('old failure outside the window restarts the counter', () => {
    assert.deepEqual(decideLockout(4, NOW - LOCKOUT_DURATION_MS - 1, NOW), { decision: 'reset', count: 1 })
  })

  test('boundary: exactly at window age counts as outside (window is strict)', () => {
    assert.deepEqual(decideLockout(4, NOW - LOCKOUT_DURATION_MS, NOW), { decision: 'reset', count: 1 })
  })

  test('NaN timestamps are treated as no stored state', () => {
    assert.deepEqual(decideLockout(3, Number.NaN, NOW), { decision: 'reset', count: 1 })
  })
})

describe('normalizeLockoutPolicy', () => {
  test('empty row → shipped defaults (off, 5 attempts, 15 minutes)', () => {
    assert.deepEqual(normalizeLockoutPolicy({}), {
      enabled: false,
      threshold: LOCKOUT_THRESHOLD,
      durationMs: LOCKOUT_DURATION_MS,
    })
  })

  test('NULL columns behave like absent ones', () => {
    assert.deepEqual(normalizeLockoutPolicy({ enabled: null, threshold: null, durationMinutes: null }), {
      enabled: false,
      threshold: LOCKOUT_THRESHOLD,
      durationMs: LOCKOUT_DURATION_MS,
    })
  })

  test('only the literal boolean true enables lockout', () => {
    assert.equal(normalizeLockoutPolicy({ enabled: true }).enabled, true)
    for (const truthy of [1, 'true', 'yes', undefined, null, 0, '']) {
      assert.equal(normalizeLockoutPolicy({ enabled: truthy }).enabled, false, `${JSON.stringify(truthy)} must not enable`)
    }
  })

  test('editable values are honoured (numeric strings from the DB included)', () => {
    const p = normalizeLockoutPolicy({ enabled: true, threshold: 3, durationMinutes: 10 })
    assert.equal(p.threshold, 3)
    assert.equal(p.durationMs, 10 * 60 * 1000)
    assert.equal(normalizeLockoutPolicy({ threshold: '7' }).threshold, 7, 'numeric strings parse')
    assert.equal(normalizeLockoutPolicy({ durationMinutes: 45 }).durationMs, 45 * 60 * 1000)
  })

  test('out-of-range and garbage values clamp to safe bounds', () => {
    assert.equal(normalizeLockoutPolicy({ threshold: 0 }).threshold, 1, 'never below 1')
    assert.equal(normalizeLockoutPolicy({ threshold: -5 }).threshold, 1)
    assert.equal(normalizeLockoutPolicy({ threshold: 10_000 }).threshold, LOCKOUT_MAX_THRESHOLD)
    assert.equal(normalizeLockoutPolicy({ threshold: 'abc' }).threshold, LOCKOUT_THRESHOLD, 'garbage → default')
    assert.equal(normalizeLockoutPolicy({ threshold: Number.NaN }).threshold, LOCKOUT_THRESHOLD)
    assert.equal(normalizeLockoutPolicy({ durationMinutes: 0 }).durationMs, 60_000, 'never below 1 minute')
    assert.equal(normalizeLockoutPolicy({ durationMinutes: 100_000 }).durationMs, LOCKOUT_MAX_DURATION_MINUTES * 60_000)
    assert.equal(normalizeLockoutPolicy({ durationMinutes: 'soon' }).durationMs, LOCKOUT_DURATION_MS)
    assert.equal(normalizeLockoutPolicy({ threshold: 3.6 }).threshold, 4, 'fractional attempts round')
  })
})
