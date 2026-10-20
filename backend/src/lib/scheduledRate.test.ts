import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_RATE_NOTE_LENGTH,
  MAX_PENDING_RATE_CHANGES,
  isDue,
  isValidRate,
  nextDueAt,
  normalizeNote,
  parseApplyAt,
  parsePendingRateChanges,
  type PendingRateChange,
} from './scheduledRate'

const NOW = new Date('2026-10-17T10:00:00.000Z') // 15:30 IST, Saturday
const FUTURE = '2026-10-18T10:30:00.000Z' // Sunday 16:00 IST

describe('isValidRate / parseApplyAt', () => {
  test('rate must be a finite positive number below the sanity cap', () => {
    assert.equal(isValidRate(95.5), true)
    assert.equal(isValidRate(0), false, 'zero is not a rate')
    assert.equal(isValidRate(-1), false)
    assert.equal(isValidRate(Number.NaN), false)
    assert.equal(isValidRate(Infinity), false)
    assert.equal(isValidRate('95.5' as unknown), false, 'strings are not coerced')
    assert.equal(isValidRate(1_000_000), false)
  })

  test('parseApplyAt accepts Date/ISO/epoch and rejects junk', () => {
    assert.equal(parseApplyAt(FUTURE)?.toISOString(), FUTURE)
    assert.equal(parseApplyAt(new Date(FUTURE))?.toISOString(), FUTURE)
    assert.ok(parseApplyAt(Date.parse(FUTURE)) instanceof Date)
    for (const bad of ['later', '', null, undefined, {}, Number.NaN]) {
      assert.equal(parseApplyAt(bad), null, `${String(bad)} → null`)
    }
  })
})

describe('normalizeNote', () => {
  test('trims, keeps short notes, and maps blank/junk to null', () => {
    assert.equal(normalizeNote('  weekend rate  '), 'weekend rate')
    assert.equal(normalizeNote(''), null)
    assert.equal(normalizeNote('   '), null)
    for (const junk of [null, undefined, 42, {}, ['x']]) {
      assert.equal(normalizeNote(junk), null, `${String(junk)} → null`)
    }
  })

  test('over-long notes are cut to the cap, never rejected', () => {
    const long = 'x'.repeat(MAX_RATE_NOTE_LENGTH + 40)
    assert.equal(normalizeNote(long)?.length, MAX_RATE_NOTE_LENGTH)
  })
})

describe('parsePendingRateChanges', () => {
  test('non-arrays and junk entries are dropped, never thrown', () => {
    assert.deepEqual(parsePendingRateChanges(null), [])
    assert.deepEqual(parsePendingRateChanges('nope'), [])
    assert.deepEqual(
      parsePendingRateChanges([
        null,
        'x',
        { rate: 95, applyAt: FUTURE }, // no id
        { id: 'a', rate: -5, applyAt: FUTURE }, // bad rate
        { id: 'b', rate: 95, applyAt: 'later' }, // bad date
      ]),
      [],
    )
  })

  test('valid entries are kept, sorted by applyAt, with normalised fields', () => {
    const list = parsePendingRateChanges([
      { id: 'later', rate: 96, applyAt: '2026-10-19T05:00:00.000Z', requestedBy: ' Ajith ' },
      { id: 'sooner', rate: 94.5, applyAt: FUTURE, requestedBy: '' },
    ])
    assert.equal(list.length, 2)
    assert.equal(list[0].id, 'sooner', 'sorted earliest first')
    assert.equal(list[1].requestedBy, 'Ajith', 'trimmed')
    assert.equal(list[0].requestedBy, null, 'blank name → null')
    assert.equal(list[1].rate, 96)
  })

  test('notes survive parsing; junk notes become null', () => {
    const list = parsePendingRateChanges([
      { id: 'noted', rate: 95, applyAt: FUTURE, note: ' weekend rate ' },
      { id: 'junk-note', rate: 95, applyAt: FUTURE, note: 12 },
      { id: 'no-note', rate: 95, applyAt: FUTURE },
    ])
    assert.equal(list.find((c) => c.id === 'noted')?.note, 'weekend rate', 'trimmed')
    assert.equal(list.find((c) => c.id === 'junk-note')?.note, null)
    assert.equal(list.find((c) => c.id === 'no-note')?.note, null)
  })

  test('duplicate ids keep the first occurrence; the list is capped', () => {
    const dupes = parsePendingRateChanges([
      { id: 'x', rate: 95, applyAt: FUTURE },
      { id: 'x', rate: 99, applyAt: FUTURE },
    ])
    assert.equal(dupes.length, 1)
    assert.equal(dupes[0].rate, 95)

    const many = Array.from({ length: MAX_PENDING_RATE_CHANGES + 5 }, (_, i) => ({
      id: `c${i}`,
      rate: 90 + i,
      applyAt: new Date(Date.parse(FUTURE) + i * 60_000).toISOString(),
    }))
    assert.equal(parsePendingRateChanges(many).length, MAX_PENDING_RATE_CHANGES)
  })
})

describe('isDue / nextDueAt', () => {
  const changes: PendingRateChange[] = [
    { id: 'past', rate: 95, applyAt: '2026-10-17T09:00:00.000Z', requestedBy: null }, // before NOW
    { id: 'soon', rate: 95, applyAt: '2026-10-17T11:00:00.000Z', requestedBy: null }, // after NOW
    { id: 'later', rate: 95, applyAt: FUTURE, requestedBy: null },
  ]

  test('due at or after its instant', () => {
    assert.equal(isDue(changes[0], NOW), true)
    assert.equal(isDue(changes[1], NOW), false)
    const exact: PendingRateChange = { id: 'e', rate: 95, applyAt: NOW.toISOString(), requestedBy: null }
    assert.equal(isDue(exact, NOW), true, 'inclusive boundary')
  })

  test('nextDueAt returns the earliest FUTURE instant, null when none', () => {
    assert.equal(nextDueAt(changes, NOW), Date.parse('2026-10-17T11:00:00.000Z'), 'past entries are not armed')
    assert.equal(nextDueAt([changes[0]], NOW), null, 'only-due/none → null (timer stops)')
    assert.equal(nextDueAt([], NOW), null)
  })
})