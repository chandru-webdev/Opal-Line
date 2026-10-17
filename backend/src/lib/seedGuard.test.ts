import test from 'node:test'
import assert from 'node:assert/strict'
import { describeDatabaseTarget, isDesktopAppDatabase } from './seedGuard'

test('describeDatabaseTarget prints host:port/db without credentials', () => {
  assert.equal(
    describeDatabaseTarget('postgresql://postgres:s3cret@127.0.0.1:47193/opal_line'),
    '127.0.0.1:47193/opal_line',
  )
  assert.equal(
    describeDatabaseTarget('postgres://user@db.example.com/mydb?sslmode=require'),
    'db.example.com:5432/mydb',
  )
  assert.equal(
    describeDatabaseTarget('postgresql://u:p@[::1]:5433/x'),
    '::1:5433/x',
  )
  assert.equal(describeDatabaseTarget('not a url'), '(unparseable DATABASE_URL)')
})

test('isDesktopAppDatabase recognises only the bundled desktop target', () => {
  assert.equal(isDesktopAppDatabase('postgresql://postgres:pw@127.0.0.1:47193/opal_line'), true)
  assert.equal(isDesktopAppDatabase('postgresql://postgres:pw@localhost:47193/opal_line'), true)
  // Same cluster but the dev database is fine to seed.
  assert.equal(isDesktopAppDatabase('postgresql://postgres:pw@127.0.0.1:47193/opal_line_dev'), false)
  // Same database name on the standard port is not the desktop app's.
  assert.equal(isDesktopAppDatabase('postgresql://postgres:pw@127.0.0.1:5432/opal_line'), false)
  assert.equal(isDesktopAppDatabase('postgres://user@db.example.com/opal_line'), false)
  assert.equal(isDesktopAppDatabase('garbage'), false)
})
