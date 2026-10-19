import test from 'node:test'
import assert from 'node:assert/strict'
import type { Server } from 'node:http'

// Financial Analytics section: the endpoint now also returns the chart series
// (`points`) and the point-in-time receivable picture. The test pins:
//   - the section's own range default (Last 12 Months when no period is sent)
//   - monthly buckets that sum back to the headline net revenue
//   - outstanding = the UNPAID part of open invoices (total − paid), with the
//     unpaid amount landing in the right aging band for its due date
//   - expense slices that always sum to the window's expense total
//
// Every assertion is a delta against a baseline fetched BEFORE the marker rows
// are inserted, so leftover rows from an earlier crashed run (or rows shared
// with other DB-gated tests) cannot make the test lie either way.
//
// Skipped unless DASHBOARD_TEST_DATABASE_URL points at a scratch database with
// the schema applied — the same contract as dashboardBuckets.test.ts.
const testUrl = process.env.DASHBOARD_TEST_DATABASE_URL?.trim()

const pad = (n: number) => String(n).padStart(2, '0')

const localNaive = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`

const dayOffset = (days: number) => new Date(Date.now() - days * 86400000)

test(
  'financial endpoint serves series, receivable summary and defaults to last 12 months',
  { skip: testUrl ? false : 'DASHBOARD_TEST_DATABASE_URL is not set' },
  async () => {
    process.env.DATABASE_URL = testUrl as string

    const express = (await import('express')).default
    const { db, schema, getRawClient } = await import('../db/client')
    const { dashboardRouter } = await import('./dashboard')
    assert.ok(db, 'test database client did not initialize')

    const marker = `fin-${Date.now()}`
    const invoices = [
      // Paid, booked right now and 70 days ago (two different months).
      { id: `${marker}-a`, number: `${marker}-A`, date: localNaive(new Date()), grandTotal: 1000, status: 'paid', paymentStatus: 'paid' },
      { id: `${marker}-b`, number: `${marker}-B`, date: localNaive(dayOffset(70)), grandTotal: 2000, status: 'paid', paymentStatus: 'paid' },
      // Partly paid: ₹800 invoiced, ₹500 received → ₹300 outstanding, and the
      // effective due date is 100 days ago so it belongs in the >90 band.
      {
        id: `${marker}-d`,
        number: `${marker}-D`,
        date: localNaive(new Date()),
        grandTotal: 800,
        status: null,
        paymentStatus: 'partial',
        dueDate: localNaive(dayOffset(100)),
      },
    ]
    const payments = [
      { id: `${marker}-pay`, ref: marker, invoice: `${marker}-D`, amount: 500, status: 'success', date: localNaive(new Date()), reconciled: true },
    ]
    const expenses = [
      { id: `${marker}-e1`, category: 'ZZ-Cat Alpha', description: marker, amount: 400, date: localNaive(new Date()), status: 'paid' },
      { id: `${marker}-e2`, category: 'ZZ-Cat Beta', description: marker, amount: 250, date: localNaive(dayOffset(70)), status: 'paid' },
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

      // Baseline before any marker row exists.
      const before = await get('/dashboard/financial?period=last12m')
      assert.equal(before.label, 'Last 12 Months')
      assert.ok(Array.isArray(before.points) && before.points.length === 12, 'last 12 months must expose 12 monthly buckets')
      assert.ok(before.receivable, 'receivable block required')

      await db!.insert(schema.salesInvoices).values(invoices)
      await db!.insert(schema.payments).values(payments)
      await db!.insert(schema.expenses).values(expenses)

      const after = await get('/dashboard/financial?period=last12m')
      const delta = (a: number, b: number) => Math.round((a - b) * 100) / 100

      // ── Headline figures: only my marker rows move ────────────────────────
      assert.equal(delta(after.netRevenue, before.netRevenue), 3800, 'net revenue gains exactly the three marker invoices')
      assert.equal(delta(after.invoiceCount, before.invoiceCount), 3, 'invoice count gains three')
      assert.equal(delta(after.expense, before.expense), 650, 'expense total gains the two marker expenses')

      // ── Chart series sums back to the headline figure ─────────────────────
      const sumIncome = (s: any) => s.points.reduce((a: number, p: any) => a + Number(p.income ?? 0), 0)
      const sumExpense = (s: any) => s.points.reduce((a: number, p: any) => a + Number(p.expense ?? 0), 0)
      assert.equal(delta(sumIncome(after), sumIncome(before)), 3800, 'series income must sum to net revenue movement')
      assert.equal(delta(sumExpense(after), sumExpense(before)), 650, 'series expense must sum to the expense movement')

      const incomeIn = (s: any, ym: string) => Number(s.points.find((p: any) => p.key === ym)?.income ?? 0)
      const expenseIn = (s: any, ym: string) => Number(s.points.find((p: any) => p.key === ym)?.expense ?? 0)
      const nowKey = `${new Date().getFullYear()}-${pad(new Date().getMonth() + 1)}`
      const ago70 = new Date(Date.now() - 70 * 86400000)
      const ago70Key = `${ago70.getFullYear()}-${pad(ago70.getMonth() + 1)}`
      assert.equal(delta(incomeIn(after, nowKey), incomeIn(before, nowKey)), 1800, "this month's income bucket holds the two current invoices")
      assert.equal(delta(incomeIn(after, ago70Key), incomeIn(before, ago70Key)), 2000, "the 70-days-ago invoice lands in its own month's bucket")
      assert.equal(delta(expenseIn(after, nowKey), expenseIn(before, nowKey)), 400, "this month's expense bucket holds the current expense")

      // ── Receivable summary: unpaid remainder, correct aging band ─────────
      assert.equal(delta(after.receivable.outstanding, before.receivable.outstanding), 300, 'outstanding = grand total − paid, not the gross invoice')
      assert.equal(delta(after.receivable.paid, before.receivable.paid), 3500, 'paid = invoiced − outstanding')
      assert.equal(delta(after.receivable.invoiceCount, before.receivable.invoiceCount), 3, 'invoiced total counts marker invoices')
      const band = (s: any, key: string) => s.receivable.aging.find((b: any) => b.key === key)
      assert.equal(delta(band(after, 'over90').value, band(before, 'over90').value), 300, 'the 100-days-overdue unpaid amount sits in >90 Days')
      assert.equal(delta(band(after, 'over90').count, band(before, 'over90').count), 1, 'one invoice in the >90 band')

      // ── Expense slices always reconcile with the expense total ───────────
      const sliceSum = after.expenses.reduce((a: number, s: any) => a + Number(s.amount ?? 0), 0)
      assert.equal(Math.round(sliceSum), Math.round(after.expense), 'category slices must sum to the expense total')
      const alpha = after.expenses.find((s: any) => s.category === 'ZZ-Cat Alpha')
      const beta = after.expenses.find((s: any) => s.category === 'ZZ-Cat Beta')
      assert.equal(alpha?.amount, 400, 'first category slice')
      assert.equal(beta?.amount, 250, 'second category slice')

      // ── The section owns its range: no period param → Last 12 Months ─────
      const defaulted = await get('/dashboard/financial')
      assert.equal(defaulted.label, 'Last 12 Months', 'bare request must default to the section range, not Today')
    } finally {
      const { inArray } = await import('drizzle-orm')
      await db!.delete(schema.salesInvoices).where(inArray(schema.salesInvoices.id, invoices.map((i) => i.id)))
      await db!.delete(schema.payments).where(inArray(schema.payments.id, payments.map((p) => p.id)))
      await db!.delete(schema.expenses).where(inArray(schema.expenses.id, expenses.map((e) => e.id)))
      server?.close()
      await getRawClient()?.end({ timeout: 5 })
    }
  },
)
