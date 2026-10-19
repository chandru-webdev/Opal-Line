import test from 'node:test'
import assert from 'node:assert/strict'
import type { Server } from 'node:http'

// Low stock: every consumer (KPI count, dashboard table, inventory overview,
// notification bell) must share one rule — trackable, stocked products at or
// below their effective reorder level, where a NULL reorder_level falls back
// to DEFAULT_REORDER_LEVEL (10) instead of silently excluding the product.
// Before the fix all four sites required `reorder_level IS NOT NULL`, so an
// imported product with no reorder level was invisible everywhere, and the
// inventory overview alone treated NULL as 0.
//
// Assertions are deltas against baselines fetched before the marker products
// are inserted, so leftovers from an earlier crashed run cannot make the test
// lie. The bell feed is checked by marker presence, not counts, because its
// low-stock query is capped at 8 rows.
//
// Skipped unless DASHBOARD_TEST_DATABASE_URL points at a scratch database with
// the schema applied — the same contract as dashboardSecurity.test.ts.
// (Separate file on purpose: each test file runs in its own process, and a
// test that closes the pool in its finally would break a second test in the
// same file.)
const testUrl = process.env.DASHBOARD_TEST_DATABASE_URL?.trim()

test(
  'low stock uses the shared default reorder level across every dashboard surface',
  { skip: testUrl ? false : 'DASHBOARD_TEST_DATABASE_URL is not set' },
  async () => {
    process.env.DATABASE_URL = testUrl as string

    const express = (await import('express')).default
    const { db, schema, getRawClient } = await import('../db/client')
    const { dashboardRouter } = await import('./dashboard')
    const { feedRouter } = await import('../notificationFeed')
    assert.ok(db, 'test database client did not initialize')

    const marker = `low-${Date.now()}`
    const zeroId = `${marker}-zero` // stock 0, no reorder level → lowest, critical
    const fourId = `${marker}-four` // stock 4, explicit reorder 4 → low
    const fiveId = `${marker}-five` // stock 5, no reorder level → default 10 counts it
    const elevenId = `${marker}-eleven` // stock 11, no reorder level → above default 10
    const offId = `${marker}-untracked` // stock 3, track_inventory=false → excluded
    const userId = `${marker}-admin`

    const ids = [zeroId, fourId, fiveId, elevenId, offId]
    const markerProduct = (id: string, stock: number, extra: Record<string, unknown> = {}) => ({
      id,
      name: `Low Stock ${id}`,
      sku: id.toUpperCase(),
      category: 'Tests',
      stock,
      ...extra,
    })

    let server: Server | null = null
    try {
      await db!.insert(schema.users).values({
        id: userId,
        name: 'Low Stock Tester',
        email: `${marker}-tester@test.local`,
        role: 'Super Admin',
        status: 'active',
      })

      const app = express()
      app.use((req, _res, next) => {
        ;(req as { userId?: string }).userId = req.header('x-test-user') ?? undefined
        next()
      })
      app.use(dashboardRouter)
      app.use(feedRouter)
      server = app.listen(0)
      const port = Number((server.address() as { port: number }).port)
      const get = async (path: string, headers: Record<string, string> = {}) => {
        const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers })
        return { status: res.status, body: (await res.json()) as any }
      }

      const baseLow = await get('/dashboard/low-stock')
      assert.equal(baseLow.status, 200)
      const baseKpis = await get('/dashboard/kpis?period=last30')
      assert.equal(baseKpis.status, 200)
      const baseOverview = await get('/dashboard/inventory-overview')
      assert.equal(baseOverview.status, 200)
      const baseFeed = await get('/notifications/feed', { 'x-test-user': userId })
      assert.equal(baseFeed.status, 200)
      const baseKpiCount = Number(
        (baseKpis.body as Array<{ key: string; value: string }>).find((k) => k.key === 'lowStock')?.value ?? -1,
      )
      assert.ok(baseKpiCount >= 0, 'KPI payload carries a lowStock count')

      await db!.insert(schema.products).values([
        markerProduct(zeroId, 0),
        markerProduct(fourId, 4, { reorderLevel: 4 }),
        markerProduct(fiveId, 5),
        markerProduct(elevenId, 11),
        markerProduct(offId, 3, { trackInventory: false }),
      ])

      // ── Dashboard table: default level, out-of-stock first ───────────────
      const rows = (await get('/dashboard/low-stock')).body as Array<{
        id: string
        stock: number
        reorderLevel: number
        status: string
      }>
      const markerRows = rows.filter((r) => r.id.startsWith(marker))
      assert.deepEqual(
        markerRows.map((r) => r.id),
        [zeroId, fourId, fiveId],
        'NULL-reorder products at or below the default count; above-default and untracked do not, sorted stock ascending (out of stock first)',
      )
      assert.equal(markerRows[0].reorderLevel, 10, 'NULL reorder level surfaces the default')
      assert.equal(markerRows[0].stock, 0)
      assert.equal(markerRows[0].status, 'critical', 'zero stock is critical')
      assert.equal(markerRows[1].status, 'low', 'stock 4 vs explicit reorder 4 is low (not doubled)')
      assert.equal(markerRows[2].reorderLevel, 10)

      // ── KPI count and inventory overview agree ────────────────────────────
      const kpis = (await get('/dashboard/kpis?period=last30')).body as Array<{ key: string; value: string }>
      const kpiCount = Number(kpis.find((k) => k.key === 'lowStock')?.value ?? -1)
      assert.equal(kpiCount, baseKpiCount + 3, 'the KPI counts the three marker products')

      const overview = (await get('/dashboard/inventory-overview')).body as { lowStock: number }
      assert.equal(overview.lowStock, baseOverview.body.lowStock + 3, 'inventory overview uses the same rule')

      // ── Notification bell: same rule, default shown in the detail line ───
      const feed = (await get('/notifications/feed', { 'x-test-user': userId })).body as {
        items: Array<{ type: string; title: string; detail: string | null }>
      }
      const lowItems = feed.items.filter((i) => i.type === 'low-stock')
      const titles = lowItems.map((i) => i.title)
      assert.ok(titles.some((t) => t.includes(zeroId)), 'the bell lists the zero-stock product')
      assert.ok(
        lowItems.find((i) => i.title.includes(zeroId))?.detail?.includes('reorder at 10'),
        'the bell detail line shows the default reorder level',
      )
      assert.ok(titles.some((t) => t.includes(fourId)), 'the bell lists the explicit-reorder product')
      assert.ok(titles.some((t) => t.includes(fiveId)), 'the bell lists the default-reorder product')
      assert.ok(!titles.some((t) => t.includes(elevenId)), 'above the default is not low stock')
      assert.ok(!titles.some((t) => t.includes(offId)), 'untracked products are not low stock')
    } finally {
      const { inArray } = await import('drizzle-orm')
      await db!.delete(schema.products).where(inArray(schema.products.id, ids))
      await db!.delete(schema.users).where(inArray(schema.users.id, [userId]))
      server?.close()
      await getRawClient()?.end({ timeout: 5 })
    }
  },
)
