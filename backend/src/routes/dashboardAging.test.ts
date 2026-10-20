import test from 'node:test'
import assert from 'node:assert/strict'
import type { Server } from 'node:http'

// Receivables Aging widget: outstanding balance bucketed by due date.
//   - voided/cancelled invoices count NOWHERE — OUTSTANDING_WHERE alone still
//     matches a cancelled invoice whose payment_status lingers at 'pending',
//     so NOT_VOIDED must be applied on top (also pins the SQL precedence).
//   - bucket VALUE is net of successful payments (a part-paid invoice
//     contributes only its unpaid remainder), the same basis as the
//     Receivable Summary; bucket MEMBERSHIP still comes from the due date.
//   - the drill-down rows return the same net figure, so expanding a bucket
//     always sums back to the bucket total.
//
// Assertions are deltas against a baseline fetched before the marker rows are
// inserted, so leftovers from an earlier crashed run cannot make the test lie.
//
// Skipped unless DASHBOARD_TEST_DATABASE_URL points at a scratch database with
// the schema applied — the same contract as dashboardPaymentStatus.test.ts.
const testUrl = process.env.DASHBOARD_TEST_DATABASE_URL?.trim()

const pad = (n: number) => String(n).padStart(2, '0')

const localNaive = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`

test(
  'receivables aging excludes voided invoices and is net of payments',
  { skip: testUrl ? false : 'DASHBOARD_TEST_DATABASE_URL is not set' },
  async () => {
    process.env.DATABASE_URL = testUrl as string

    const express = (await import('express')).default
    const { db, schema, getRawClient } = await import('../db/client')
    const { dashboardRouter } = await import('./dashboard')
    assert.ok(db, 'test database client did not initialize')

    const marker = `aging-${Date.now()}`
    const day = 86400000
    const now = localNaive(new Date())
    const ago = (d: number) => localNaive(new Date(Date.now() - d * day))

    const invoices = [
      // Not yet due (no due date) → current.
      { id: `${marker}-cur`, number: `${marker}-CUR`, date: now, grandTotal: 1000, status: 'pending', paymentStatus: 'pending' },
      // 40 days past due → 31–60.
      { id: `${marker}-o40`, number: `${marker}-O40`, date: ago(70), dueDate: ago(40), grandTotal: 500, status: 'overdue', paymentStatus: 'pending' },
      // 70 days past due → 60+.
      { id: `${marker}-o70`, number: `${marker}-O70`, date: ago(100), dueDate: ago(70), grandTotal: 400, status: 'overdue', paymentStatus: 'pending' },
      // 10 days past due, ₹1500 of ₹2000 paid → 1–30 with value 500, not 2000.
      { id: `${marker}-part`, number: `${marker}-PART`, date: ago(40), dueDate: ago(10), grandTotal: 2000, status: 'pending', paymentStatus: 'partial' },
      // Cancelled but payment_status still 'pending' → counts nowhere.
      { id: `${marker}-void`, number: `${marker}-VOID`, date: ago(70), dueDate: ago(40), grandTotal: 9999, status: 'cancelled', paymentStatus: 'pending' },
    ]
    const payments = [
      { id: `${marker}-pay`, invoice: `${marker}-PART`, amount: 1500, status: 'success', date: now },
      // A failed attempt at payment must NOT reduce the outstanding amount.
      { id: `${marker}-payfail`, invoice: `${marker}-PART`, amount: 500, status: 'failed', date: now },
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

      const before = await get('/dashboard/aging')
      await db!.insert(schema.salesInvoices).values(invoices)
      await db!.insert(schema.payments).values(payments)
      const after = await get('/dashboard/aging')

      const bucket = (payload: any, key: string) =>
        payload.buckets.find((b: any) => b.key === key) ?? { value: -1, count: -1 }
      const delta = (a: number, b: number) => Math.round((a - b) * 100) / 100

      // ── Bucket membership and net values ──────────────────────────────────
      assert.equal(delta(bucket(after, 'current').value, bucket(before, 'current').value), 1000, 'current gains the not-yet-due invoice')
      assert.equal(delta(bucket(after, 'current').count, bucket(before, 'current').count), 1)
      assert.equal(delta(bucket(after, 'd1_30').value, bucket(before, 'd1_30').value), 500, '1–30 gains only the unpaid remainder of the part-paid invoice')
      assert.equal(delta(bucket(after, 'd1_30').count, bucket(before, 'd1_30').count), 1)
      assert.equal(delta(bucket(after, 'd31_60').value, bucket(before, 'd31_60').value), 500, '31–60 gains the 40-day overdue invoice and NOT the voided one')
      assert.equal(delta(bucket(after, 'd31_60').count, bucket(before, 'd31_60').count), 1, 'the cancelled invoice must not appear in 31–60')
      assert.equal(delta(bucket(after, 'd60plus').value, bucket(before, 'd60plus').value), 400, '60+ gains the 70-day overdue invoice')
      assert.equal(delta(bucket(after, 'd60plus').count, bucket(before, 'd60plus').count), 1)

      // ── Headlines: totals sum, voided counted nowhere ─────────────────────
      assert.equal(delta(after.total, before.total), 2400, 'total gains 1000+500+500+400 and never the 9999 voided invoice')
      assert.equal(delta(after.invoiceCount, before.invoiceCount), 4, 'four live invoices, not five')
      assert.equal(delta(after.overdueTotal, before.overdueTotal), 1400, 'overdue = 500+500+400')
      assert.equal(delta(after.overdueCount, before.overdueCount), 3)
      const sum = after.buckets.reduce((acc: number, b: any) => acc + b.value, 0)
      assert.equal(Math.round(sum * 100) / 100, after.total, 'buckets must sum to the total')

      // ── Drill-down: net amounts, voided absent ────────────────────────────
      const d31 = await get(`/dashboard/aging/invoices?bucket=d31_60`)
      const o40 = d31.invoices.find((i: any) => i.number === `${marker}-O40`)
      assert.ok(o40, 'the 40-day overdue invoice is in its bucket')
      assert.equal(o40.outstanding, 500, 'unpaid invoice drills down at full value')
      assert.equal(o40.grandTotal, 500)
      assert.ok(!d31.invoices.some((i: any) => i.number === `${marker}-VOID`), 'voided invoice never drills down')

      const d1 = await get(`/dashboard/aging/invoices?bucket=d1_30`)
      const part = d1.invoices.find((i: any) => i.number === `${marker}-PART`)
      assert.ok(part, 'the part-paid invoice is in its bucket')
      assert.equal(part.outstanding, 500, 'drill-down shows the unpaid remainder')
      assert.equal(part.grandTotal, 2000, 'grand total is still reported for context')

      const cur = await get(`/dashboard/aging/invoices?bucket=current`)
      assert.ok(cur.invoices.some((i: any) => i.number === `${marker}-CUR` && i.outstanding === 1000))

      // Unknown bucket → 400, not a silent empty list.
      const bad = await fetch(`http://127.0.0.1:${port}/dashboard/aging/invoices?bucket=Nope`)
      assert.equal(bad.status, 400)
    } finally {
      const { inArray } = await import('drizzle-orm')
      await db!.delete(schema.salesInvoices).where(inArray(schema.salesInvoices.id, invoices.map((i) => i.id)))
      await db!.delete(schema.payments).where(inArray(schema.payments.id, payments.map((p) => p.id)))
      server?.close()
      await getRawClient()?.end({ timeout: 5 })
    }
  },
)
