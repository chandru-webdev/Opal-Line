import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { parseNotificationPrefs, resolveOwnerRecipient } from './notificationPrefs'

const ORIGINAL_ENV = process.env.NOTIFICATION_EMAIL

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.NOTIFICATION_EMAIL
  else process.env.NOTIFICATION_EMAIL = ORIGINAL_ENV
})

test('missing settings default every scheduler to enabled', () => {
  const prefs = parseNotificationPrefs(null)
  assert.equal(prefs.dailySummaryEnabled, true)
  assert.equal(prefs.weeklyReportEnabled, true)
  assert.equal(prefs.monthlyStatementsEnabled, true)
  assert.equal(prefs.dueRemindersEnabled, true)
  assert.equal(prefs.recipientEmail, '')
})

test('stored toggles are honoured (switches actually disable schedulers)', () => {
  const prefs = parseNotificationPrefs({
    dailySummaryEnabled: false,
    weeklyReportEnabled: true,
    monthlyStatementsEnabled: false,
    dueRemindersEnabled: true,
  })
  assert.equal(prefs.dailySummaryEnabled, false)
  assert.equal(prefs.weeklyReportEnabled, true)
  assert.equal(prefs.monthlyStatementsEnabled, false)
  assert.equal(prefs.dueRemindersEnabled, true)
})

test('malformed values fall back to enabled rather than silently disabling', () => {
  const prefs = parseNotificationPrefs({
    dailySummaryEnabled: 'nope',
    weeklyReportEnabled: 0,
    recipientEmail: 42,
  })
  assert.equal(prefs.dailySummaryEnabled, true)
  assert.equal(prefs.weeklyReportEnabled, true)
  assert.equal(prefs.recipientEmail, '')
})

test('UI recipient wins over NOTIFICATION_EMAIL env', () => {
  const prefs = parseNotificationPrefs({ recipientEmail: ' ui@example.com ' }, 'env@example.com')
  assert.equal(prefs.recipientEmail, 'ui@example.com')
})

test('empty UI recipient falls back to NOTIFICATION_EMAIL env', () => {
  const prefs = parseNotificationPrefs({ recipientEmail: '   ' }, 'env@example.com')
  assert.equal(prefs.recipientEmail, 'env@example.com')
})

test('resolveOwnerRecipient: UI > env > business email', () => {
  process.env.NOTIFICATION_EMAIL = 'env@example.com'
  const ui = parseNotificationPrefs({ recipientEmail: 'ui@example.com' })
  assert.equal(resolveOwnerRecipient(ui, 'business@example.com'), 'ui@example.com')

  const noUi = parseNotificationPrefs(null)
  assert.equal(resolveOwnerRecipient(noUi, 'business@example.com'), 'env@example.com')

  delete process.env.NOTIFICATION_EMAIL
  const noEnv = parseNotificationPrefs(null)
  assert.equal(resolveOwnerRecipient(noEnv, 'business@example.com'), 'business@example.com')
  assert.equal(resolveOwnerRecipient(noEnv, '  '), '')
})
