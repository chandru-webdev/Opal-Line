import test from 'node:test'
import assert from 'node:assert/strict'

// The dashboard sales-overview chart groups revenue per period. A regression in
// these queries — Drizzle emitting the bucket-format bind param twice, so
// Postgres saw two different expressions in SELECT and GROUP BY and rejected
// the statement — is invisible to the DB-less suite and only shows up as a 500
// on the live endpoint. This test runs the real aggregate against a scratch
// database to pin the grouping, the voided exclusion and the returns netting.
//
// It is skipped unless DASHBOARD_TEST_DATABASE_URL points at a scratch database
// with the schema applied. It never touches the app database: the value is
// copied into DATABASE_URL *before* the db client is imported, and every row it
// inserts carries a unique marker and is deleted again in a finally block.
const testUrl = process.env.DASHBOARD_TEST_DATABASE_URL?.trim()

test(
  'sales-overview buckets group revenue by period and net out returns',
  { skip: testUrl ? false : 'DASHBOARD_TEST_DATABASE_URL is not set' },
  async () => {
    process.env.DATABASE_URL = testUrl as string

    const { db, schema } = await import('../db/client')
    const { salesBuckets, returnBuckets } = await import('./dashboard')
    assert.ok(db, 'test database client did not initialize')

    const marker = `dash-bucket-${Date.now()}`
    const invoices = [
      { id: `${marker}-a`, number: `${marker}-A`, date: '2026-01-05T10:00:00', grandTotal: 100, status: 'paid' },
      { id: `${marker}-b`, number: `${marker}-B`, date: '2026-01-20T10:00:00', grandTotal: 200, status: 'paid' },
      { id: `${marker}-c`, number: `${marker}-C`, date: '2026-02-10T10:00:00', grandTotal: 50, status: 'paid' },
      // Voided invoices must never count towards revenue.
      { id: `${marker}-x`, number: `${marker}-X`, date: '2026-01-15T10:00:00', grandTotal: 999, status: 'cancelled' },
    ]
    const returns = [
      { id: `${marker}-r1`, number: `${marker}-R1`, date: '2026-01-06T10:00:00', amount: 30, status: 'approved' },
      // Cancelled returns are ignored.
      { id: `${marker}-r2`, number: `${marker}-R2`, date: '2026-01-07T10:00:00', amount: 500, status: 'cancelled' },
    ]

    try {
      await db!.insert(schema.salesInvoices).values(invoices)
      await db!.insert(schema.salesReturns).values(returns)

      const range = { from: '2026-01-01T00:00:00', to: '2026-03-01T00:00:00' }

      const byDay = await salesBuckets('YYYY-MM-DD', range)
      assert.equal(byDay.get('2026-01-05')?.revenue, 100)
      assert.equal(byDay.get('2026-01-05')?.orders, 1)
      assert.equal(byDay.get('2026-01-20')?.revenue, 200)
      assert.equal(byDay.get('2026-02-10')?.revenue, 50)
      assert.equal(byDay.get('2026-01-15'), undefined, 'voided invoice must be excluded')

      const byMonth = await salesBuckets('YYYY-MM', range)
      assert.equal(byMonth.get('2026-01')?.revenue, 300)
      assert.equal(byMonth.get('2026-02')?.revenue, 50)

      const ret = await returnBuckets('YYYY-MM-DD', range)
      assert.equal(ret.get('2026-01-06'), 30)
      assert.equal(ret.get('2026-01-07'), undefined, 'cancelled return must be excluded')

      // The chart nets returns off the matching bucket.
      const netted = (byDay.get('2026-01-06')?.revenue ?? 0) - (ret.get('2026-01-06') ?? 0)
      assert.equal(netted, -30)
    } finally {
      const { inArray } = await import('drizzle-orm')
      await db!.delete(schema.salesInvoices).where(inArray(schema.salesInvoices.id, invoices.map((i) => i.id)))
      await db!.delete(schema.salesReturns).where(inArray(schema.salesReturns.id, returns.map((r) => r.id)))
    }
  },
)
