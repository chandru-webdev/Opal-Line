import test from 'node:test'
import assert from 'node:assert/strict'
import type { Server } from 'node:http'

// Payment Status widget: the donut centre must show the FULL total and the four
// rows (Paid, Pending, Failed / Overdue, Refunded) must add up to it, so the
// percentages always sum to 100%. The test pins the segment precedence:
//   refunded (status or payment_status = 'refunded')
//   → failed / overdue (payment_status = 'failed' or status = 'overdue')
//   → paid → pending (the catch-all)
// and that cancelled (void) invoices and rows outside the window count nowhere.
//
// Assertions are deltas against a baseline fetched before the marker rows are
// inserted, so leftovers from an earlier crashed run cannot make the test lie.
//
// Skipped unless DASHBOARD_TEST_DATABASE_URL points at a scratch database with
// the schema applied — the same contract as dashboardBuckets.test.ts.
const testUrl = process.env.DASHBOARD_TEST_DATABASE_URL?.trim()

const pad = (n: number) => String(n).padStart(2, '0')

const localNaive = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`

test(
  'payment status has four mutually exclusive segments that sum to the donut total',
  { skip: testUrl ? false : 'DASHBOARD_TEST_DATABASE_URL is not set' },
  async () => {
    process.env.DATABASE_URL = testUrl as string

    const express = (await import('express')).default
    const { db, schema, getRawClient } = await import('../db/client')
    const { dashboardRouter } = await import('./dashboard')
    assert.ok(db, 'test database client did not initialize')

    const marker = `pay-${Date.now()}`
    const now = localNaive(new Date())
    const yesterday = localNaive(new Date(Date.now() - 86400000))
    const invoices = [
      // Paid.
      { id: `${marker}-paid`, number: `${marker}-PAID`, date: now, grandTotal: 1000, status: 'paid', paymentStatus: 'paid' },
      // Overdue invoice that is still 'pending' payment: the failed / overdue
      // bucket wins over the pending catch-all.
      { id: `${marker}-overdue`, number: `${marker}-OVERDUE`, date: now, grandTotal: 400, status: 'overdue', paymentStatus: 'pending' },
      // Explicit gateway failure.
      { id: `${marker}-failed`, number: `${marker}-FAILED`, date: now, grandTotal: 300, status: null, paymentStatus: 'failed' },
      // Open invoices with no failure: plain pending, partial and a null status.
      { id: `${marker}-pending`, number: `${marker}-PENDING`, date: now, grandTotal: 250, status: null, paymentStatus: 'pending' },
      { id: `${marker}-partial`, number: `${marker}-PARTIAL`, date: now, grandTotal: 150, status: null, paymentStatus: 'partial' },
      { id: `${marker}-due`, number: `${marker}-DUE`, date: now, grandTotal: 200, status: null, paymentStatus: null },
      // Refunded invoice (status), and one flagged only through payment_status.
      { id: `${marker}-refunded`, number: `${marker}-REFUNDED`, date: now, grandTotal: 700, status: 'refunded', paymentStatus: 'refunded' },
      { id: `${marker}-refunded-ps`, number: `${marker}-REFUNDED-PS`, date: now, grandTotal: 500, status: 'paid', paymentStatus: 'refunded' },
      // Void: cancelled, and a paid row dated outside today's window.
      { id: `${marker}-cancelled`, number: `${marker}-CANCELLED`, date: now, grandTotal: 900, status: 'cancelled', paymentStatus: 'paid' },
      { id: `${marker}-old`, number: `${marker}-OLD`, date: yesterday, grandTotal: 5000, status: 'paid', paymentStatus: 'paid' },
    ]

    let server: Server | null = null
    try {
      const app = express()
      app.use(dashboardRouter)
      server = app.listen(0)
      const port = Number((server.address() as { port: number }).port)
      const get = async (path: string) => {
        const res = await fetch(`http://127.0.0.1:${port}${path}`)
        assert.equal(res.status, 200, `${path} responded ${res.status}`)
        return (await res.json()) as any
      }

      const segment = (payload: any, status: string) =>
        payload.segments.find((s: any) => s.status === status) ?? { value: -1, count: -1 }
      const delta = (a: number, b: number) => Math.round((a - b) * 100) / 100

      const before = await get('/dashboard/payment-status?period=today')
      await db!.insert(schema.salesInvoices).values(invoices)
      const after = await get('/dashboard/payment-status?period=today')

      // ── Four rows, in the agreed order and with the agreed labels ─────────
      assert.deepEqual(
        after.segments.map((s: any) => s.status),
        ['paid', 'pending', 'failed', 'refunded'],
        'segments must be Paid, Pending, Failed / Overdue, Refunded',
      )
      assert.deepEqual(
        after.segments.map((s: any) => s.label),
        ['Paid', 'Pending', 'Failed / Overdue', 'Refunded'],
      )

      // ── Each marker invoice lands in exactly one segment ─────────────────
      assert.equal(delta(segment(after, 'paid').value, segment(before, 'paid').value), 1000, 'paid segment gains the paid invoice')
      assert.equal(delta(segment(after, 'paid').count, segment(before, 'paid').count), 1)
      assert.equal(delta(segment(after, 'pending').value, segment(before, 'pending').value), 600, 'pending = pending + partial + due')
      assert.equal(delta(segment(after, 'pending').count, segment(before, 'pending').count), 3)
      assert.equal(delta(segment(after, 'failed').value, segment(before, 'failed').value), 700, 'failed/overdue = gateway failure + overdue-pending')
      assert.equal(delta(segment(after, 'failed').count, segment(before, 'failed').count), 2)
      assert.equal(delta(segment(after, 'refunded').value, segment(before, 'refunded').value), 1200, 'refunded catches status=refunded and payment_status=refunded')
      assert.equal(delta(segment(after, 'refunded').count, segment(before, 'refunded').count), 2)

      // ── Cancelled and out-of-window rows change the total by nothing ─────
      assert.equal(delta(after.total, before.total), 3500, 'total gains only the nine live, in-window invoices')

      // ── The donut centre equals the sum of its rows ─────────────────────
      const sum = after.segments.reduce((acc: number, s: any) => acc + s.value, 0)
      assert.equal(Math.round(sum), Math.round(after.total), 'segments must sum to the centred total')
      const sumBefore = before.segments.reduce((acc: number, s: any) => acc + s.value, 0)
      assert.equal(Math.round(sumBefore), Math.round(before.total), 'baseline segments must also sum to the baseline total')
    } finally {
      const { inArray } = await import('drizzle-orm')
      await db!.delete(schema.salesInvoices).where(inArray(schema.salesInvoices.id, invoices.map((i) => i.id)))
      server?.close()
      await getRawClient()?.end({ timeout: 5 })
    }
  },
)
