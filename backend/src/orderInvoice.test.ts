import test from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'

// Raising an invoice from a Shopify order is what makes the dashboard's
// invoice-derived widgets (sales, invoices, top products/category, payment
// status) populate after an Orders Sync. This test runs createInvoiceForOrderRow
// against a scratch database to pin the totals, the stock opt-out the order
// import relies on, and idempotency — a second call must return the same number
// without creating a duplicate or moving stock twice.
//
// Skipped unless DASHBOARD_TEST_DATABASE_URL points at a scratch database with
// the schema applied. The value is copied into DATABASE_URL *before* the db
// client is imported, and rows are removed again in a finally block.
const testUrl = process.env.DASHBOARD_TEST_DATABASE_URL?.trim()

test(
  'createInvoiceForOrderRow raises one invoice per paid order and is idempotent',
  { skip: testUrl ? false : 'DASHBOARD_TEST_DATABASE_URL is not set' },
  async () => {
    process.env.DATABASE_URL = testUrl as string
    process.env.LOYALTY_ENABLED = 'false'

    const { db, schema } = await import('./db/client')
    const { createInvoiceForOrderRow } = await import('./orderEmailIngest')
    assert.ok(db, 'test database client did not initialize')

    const marker = `inv-order-${Date.now()}`
    const shopifyId = `#${marker}`
    // The catalogue knows SKU1's net weight (12.5 g); SKU2 is unknown, so its
    // invoice item must keep weight 0 (rendered as "—", never "0.00 gm").
    const sku1 = `${marker}-SKU1`
    const sku2 = `${marker}-SKU2`
    const productId = `${marker}-prod`
    const order = {
      id: `${marker}-order`,
      shopifyId,
      customer: `${marker} Buyer`,
      value: 2060,
      payment: 'paid',
      status: 'imported',
      date: '2026-05-10T09:00:00',
      discount: 0,
      lineItems: [
        { title: 'Silver Ring', sku: sku1, quantity: 2, price: 500 },
        { title: 'Silver Chain', sku: sku2, quantity: 1, price: 1000 },
      ],
    }

    let invoiceId: string | null = null
    try {
      await db!.insert(schema.products).values({
        id: productId,
        name: 'Silver Ring (test)',
        sku: sku1,
        category: 'test',
        netWeight: 12.5,
      })
      await db!.insert(schema.salesOrders).values(order)
      const [row] = await db!
        .select()
        .from(schema.salesOrders)
        .where(eq(schema.salesOrders.shopifyId, shopifyId))
        .limit(1)

      // The order import already moved stock, so it opts the invoice out.
      const number = await createInvoiceForOrderRow(row, { deductStock: false })
      assert.ok(number, 'a paid order with line items must get an invoice')

      const [invoice] = await db!
        .select()
        .from(schema.salesInvoices)
        .where(eq(schema.salesInvoices.shopifyOrder, shopifyId))
        .limit(1)
      invoiceId = invoice.id
      assert.equal(invoice.number, number)
      assert.equal(invoice.customer, order.customer)
      // 2 x 500 + 1 x 1000 = 2000, GST 3% = 60, no discount.
      assert.equal(Number(invoice.subtotal), 2000)
      assert.equal(Number(invoice.gstAmount), 60)
      assert.equal(Number(invoice.grandTotal), 2060)
      assert.equal(invoice.paymentStatus, 'paid')
      assert.equal(invoice.status, 'paid')
      assert.equal(invoice.shopifyOrder, shopifyId)

      const items = await db!
        .select()
        .from(schema.salesInvoiceItems)
        .where(eq(schema.salesInvoiceItems.invoiceId, invoice.id))
      assert.equal(items.length, 2)
      assert.equal(items.reduce((a, it) => a + Number(it.amount), 0), 2000)

      // Weight snapshot: net weight × qty when the catalogue knows the SKU,
      // 0 (unknown) when it doesn't.
      const ring = items.find((it) => it.sku === sku1)
      const chain = items.find((it) => it.sku === sku2)
      assert.ok(ring, 'ring item must exist')
      assert.ok(chain, 'chain item must exist')
      assert.equal(Number(ring.weight), 25, 'weight snapshot = 12.5 g × 2')
      assert.equal(Number(chain.weight), 0, 'unknown SKU keeps weight 0')

      // The order now points at its invoice.
      const [linked] = await db!
        .select({ invoice: schema.salesOrders.invoice })
        .from(schema.salesOrders)
        .where(eq(schema.salesOrders.shopifyId, shopifyId))
        .limit(1)
      assert.equal(linked.invoice, number)

      // Idempotent: a re-sync must not create a second invoice.
      const again = await createInvoiceForOrderRow(
        (await db!.select().from(schema.salesOrders).where(eq(schema.salesOrders.shopifyId, shopifyId)).limit(1))[0],
        { deductStock: false },
      )
      assert.equal(again, number)
      const all = await db!
        .select({ id: schema.salesInvoices.id })
        .from(schema.salesInvoices)
        .where(eq(schema.salesInvoices.shopifyOrder, shopifyId))
      assert.equal(all.length, 1, 're-sync must not duplicate the invoice')
    } finally {
      if (invoiceId) {
        await db!.delete(schema.salesInvoiceItems).where(eq(schema.salesInvoiceItems.invoiceId, invoiceId))
        await db!.delete(schema.salesInvoices).where(eq(schema.salesInvoices.id, invoiceId))
      }
      await db!.delete(schema.salesOrders).where(eq(schema.salesOrders.shopifyId, shopifyId))
      await db!.delete(schema.products).where(eq(schema.products.id, productId))
    }
  },
)

test(
  'backfillInvoiceItemWeights fills weight 0 items from the catalogue, once',
  { skip: testUrl ? false : 'DASHBOARD_TEST_DATABASE_URL is not set' },
  async () => {
    process.env.DATABASE_URL = testUrl as string

    const { db, schema } = await import('./db/client')
    const { backfillInvoiceItemWeights } = await import('./invoiceWeights')
    assert.ok(db, 'test database client did not initialize')

    const marker = `inv-weight-${Date.now()}`
    const skuKnown = `${marker}-KNOWN`
    const skuUnknown = `${marker}-UNKNOWN`
    const productId = `${marker}-prod`
    const invoiceId = `${marker}-inv`
    const knownItemId = `${marker}-item-known`
    const unknownItemId = `${marker}-item-unknown`
    const alreadyItemId = `${marker}-item-already`
    try {
      await db!.insert(schema.products).values({
        id: productId,
        name: 'Weight Backfill Ring (test)',
        sku: skuKnown,
        category: 'test',
        netWeight: 8.25,
      })
      await db!.insert(schema.salesInvoices).values({
        id: invoiceId,
        number: `${marker}-INV`,
        customer: 'Backfill Test',
        gst: 3,
        subtotal: 0,
        gstAmount: 0,
        discount: 0,
        grandTotal: 0,
        date: '2026-05-10T09:00:00',
      })
      await db!.insert(schema.salesInvoiceItems).values([
        // Weight 0 + a catalogue net weight → backfilled to 8.25 × 3.
        { id: knownItemId, invoiceId, sku: skuKnown, product: 'Ring', qty: 3, weight: 0, amount: 0 },
        // No product record → stays 0 (unknown).
        { id: unknownItemId, invoiceId, sku: skuUnknown, product: 'Mystery', qty: 2, weight: 0, amount: 0 },
        // Already carries a weight → never overwritten.
        { id: alreadyItemId, invoiceId, sku: skuKnown, product: 'Ring kept', qty: 1, weight: 5.5, amount: 0 },
      ])

      const updated = await backfillInvoiceItemWeights(db!)
      assert.ok(updated >= 1, 'at least the weight-0 item must be updated')

      const items = await db!
        .select()
        .from(schema.salesInvoiceItems)
        .where(eq(schema.salesInvoiceItems.invoiceId, invoiceId))
      const known = items.find((it) => it.id === knownItemId)
      const unknown = items.find((it) => it.id === unknownItemId)
      const already = items.find((it) => it.id === alreadyItemId)
      assert.equal(Number(known!.weight), 24.75, 'backfill = net weight × qty')
      assert.equal(Number(unknown!.weight), 0, 'unknown SKU stays 0')
      assert.equal(Number(already!.weight), 5.5, 'existing weight is never overwritten')

      // Idempotent: a second run must change nothing.
      const again = await backfillInvoiceItemWeights(db!)
      const [knownAfter] = await db!
        .select()
        .from(schema.salesInvoiceItems)
        .where(eq(schema.salesInvoiceItems.id, knownItemId))
      assert.equal(Number(knownAfter.weight), 24.75)
      assert.ok(again >= 0, 'second run completes')
    } finally {
      await db!.delete(schema.salesInvoiceItems).where(eq(schema.salesInvoiceItems.invoiceId, invoiceId))
      await db!.delete(schema.salesInvoices).where(eq(schema.salesInvoices.id, invoiceId))
      await db!.delete(schema.products).where(eq(schema.products.id, productId))
    }
  },
)
