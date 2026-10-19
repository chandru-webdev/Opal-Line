import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_RATE_SCHEDULE,
  IST_UTC_OFFSET_MS,
  describeRateSchedule,
  nextScheduledRun,
  parseRateSchedule,
  type SilverRateSchedule,
} from './rateSchedule'

/** Build the instant of an IST wall-clock moment, for deterministic tests. */
function ist(y: number, mo: number, d: number, h = 0, mi = 0, s = 0): Date {
  return new Date(Date.UTC(y, mo - 1, d, h, mi, s) - IST_UTC_OFFSET_MS)
}

// October 2026: the 3rd/10th/17th are Saturdays, the 4th/11th/18th Sundays,
// the 12th a Monday and the 13th a Tuesday.
describe('parseRateSchedule', () => {
  test('absent/invalid input falls back to the shipped default', () => {
    for (const raw of [undefined, null, 'nonsense', 42, [], {}, { days: [], time: 'later' }]) {
      assert.deepEqual(parseRateSchedule(raw), DEFAULT_RATE_SCHEDULE, `${JSON.stringify(raw)} → default`)
    }
  })

  test('keeps only unique valid weekdays and sorts them', () => {
    assert.deepEqual(parseRateSchedule({ days: [6, 0, 6, 7, -1, 'x', '3'] }).days, [0, 3, 6])
  })

  test('valid time is kept, zero-padded; invalid time falls back', () => {
    assert.equal(parseRateSchedule({ time: '10:30' }).time, '10:30')
    assert.equal(parseRateSchedule({ time: ' 7:05 ' }).time, '07:05', 'single-digit hour is padded')
    assert.equal(parseRateSchedule({ time: '23:59' }).time, '23:59')
    for (const bad of ['24:00', '09:60', 'nine', '', '0900', '09:0']) {
      assert.equal(parseRateSchedule({ time: bad }).time, '09:00', `${bad} → 09:00`)
    }
  })
})

describe('nextScheduledRun', () => {
  test('default schedule: next 09:00 IST, same day when still ahead', () => {
    // Tuesday 13 Oct 08:00 IST → later that Tuesday 09:00 IST.
    assert.equal(nextScheduledRun(ist(2026, 10, 13, 8, 0), DEFAULT_RATE_SCHEDULE).getTime(), ist(2026, 10, 13, 9, 0).getTime())
    // Tuesday 10:00 IST → Wednesday 09:00 IST.
    assert.equal(nextScheduledRun(ist(2026, 10, 13, 10, 0), DEFAULT_RATE_SCHEDULE).getTime(), ist(2026, 10, 14, 9, 0).getTime())
  })

  test('exactly on the scheduled minute rolls to the next day (strictly-ahead rule)', () => {
    assert.equal(nextScheduledRun(ist(2026, 10, 13, 9, 0, 0), DEFAULT_RATE_SCHEDULE).getTime(), ist(2026, 10, 14, 9, 0).getTime())
  })

  test('weekend-only schedule skips to Saturday/Sunday', () => {
    const weekend: SilverRateSchedule = { days: [0, 6], time: '10:30' }
    // Tuesday → the coming Saturday.
    assert.equal(nextScheduledRun(ist(2026, 10, 13, 8, 0), weekend).getTime(), ist(2026, 10, 17, 10, 30).getTime())
    // Saturday before the run → same Saturday.
    assert.equal(nextScheduledRun(ist(2026, 10, 17, 8, 0), weekend).getTime(), ist(2026, 10, 17, 10, 30).getTime())
    // Saturday after the run → Sunday.
    assert.equal(nextScheduledRun(ist(2026, 10, 17, 11, 0), weekend).getTime(), ist(2026, 10, 18, 10, 30).getTime())
    // Sunday after the run → the NEXT Saturday (7 days later).
    assert.equal(nextScheduledRun(ist(2026, 10, 18, 11, 0), weekend).getTime(), ist(2026, 10, 24, 10, 30).getTime())
  })

  test('single-day schedule waits for its day', () => {
    const wedOnly: SilverRateSchedule = { days: [3], time: '09:00' }
    // Thursday → next Wednesday.
    assert.equal(nextScheduledRun(ist(2026, 10, 15, 10, 0), wedOnly).getTime(), ist(2026, 10, 21, 9, 0).getTime())
  })

  test('midnight schedule crosses the IST day boundary correctly', () => {
    const midnight: SilverRateSchedule = { days: [1], time: '00:05' }
    // Monday 00:10 IST (past today's run) → next Monday.
    assert.equal(nextScheduledRun(ist(2026, 10, 12, 0, 10), midnight).getTime(), ist(2026, 10, 19, 0, 5).getTime())
    // Sunday 23:00 IST → the Monday that starts in an hour.
    assert.equal(nextScheduledRun(ist(2026, 10, 18, 23, 0), midnight).getTime(), ist(2026, 10, 19, 0, 5).getTime())
  })
})

describe('describeRateSchedule', () => {
  test('summarises day sets for the UI', () => {
    assert.equal(describeRateSchedule(DEFAULT_RATE_SCHEDULE), 'Every day at 09:00 IST')
    assert.equal(describeRateSchedule({ days: [1, 2, 3, 4, 5], time: '10:00' }), 'Mon–Fri at 10:00 IST')
    assert.equal(describeRateSchedule({ days: [0, 6], time: '08:15' }), 'Sat, Sun at 08:15 IST', 'weeks display starting Monday')
    assert.equal(describeRateSchedule({ days: [6], time: '07:00' }), 'Sat at 07:00 IST')
  })
})