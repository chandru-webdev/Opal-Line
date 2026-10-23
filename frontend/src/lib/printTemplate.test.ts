import test from 'node:test'
import assert from 'node:assert/strict'
import { buildPrintHtml, invoicePrintDoc, mergePrintConfig } from '@/lib/printTemplate'
import type { Invoice } from '@/types'

// The invoice screen and the printed page must show the SAME persisted values.
// These tests build the print HTML through the real invoice → doc → HTML path
// (invoicePrintDoc is exactly what InvoiceDetail prints with) and compare what
// comes out against the invoice row a details API response would return.

function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: 'inv-print-1',
    number: 'INV-202605101234',
    shopifyOrder: '#T1',
    customer: 'Ashok Testbuyer',
    customerEmail: 'ashok@example.com',
    customerPhone: '9000000001',
    customerAddress: '12 Test Street',
    customerCity: 'Coimbatore',
    customerState: 'Tamil Nadu',
    customerPincode: '641001',
    items: [
      { product: 'Silver Ring', sku: 'SKU-RING-A', hsn: '7113', qty: 2, weight: 25, silverRate: 0, makingCharge: 0, tax: 30, amount: 1000 },
      { product: 'Gold Pendant', sku: 'SKU-PENDANT-B', hsn: '7114', qty: 1, weight: 10, silverRate: 0, makingCharge: 45, tax: 40.52, amount: 1350.5 },
    ],
    silverValue: 0,
    makingCharge: 45,
    subtotal: 2350.5,
    gst: 3,
    gstAmount: 70.52,
    discount: 100,
    grandTotal: 2321.02,
    paymentMethod: 'upi',
    paymentStatus: 'paid',
    status: 'paid',
    date: '2026-05-10T09:00:00',
    businessName: 'Opal Line',
    ...overrides,
  }
}

const CONFIG = mergePrintConfig(undefined)

function printInvoice(invoice: Invoice, business?: NonNullable<Parameters<typeof invoicePrintDoc>[1]>['business']): string {
  return buildPrintHtml(invoicePrintDoc(invoice, { business }), CONFIG, { docType: 'invoice' })
}

/** Value printed in the totals box for a given row label, e.g. "Taxable Value". */
function rowValue(html: string, label: string): string | null {
  const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = html.match(new RegExp(`<span>${esc}</span><span>([^<]*)</span>`))
  return m ? m[1] : null
}

const rupees = (cell: string | null): number => Number((cell ?? '').replace(/[^0-9.]/g, ''))

/** The <tr> that contains the given product name (its own row's markup). */
function itemRow(html: string, product: string): string {
  const rows = html.split('<tr').filter((r) => r.includes(product))
  assert.equal(rows.length, 1, `expected exactly one row for ${product}`)
  return rows[0]
}

test('invoicePrintDoc maps the persisted invoice onto the print document without recalculating', () => {
  const invoice = makeInvoice()
  const doc = invoicePrintDoc(invoice)

  // Header/total fields pass through untouched — printing reads stored values.
  assert.equal(doc.number, invoice.number)
  assert.equal(doc.customer, invoice.customer)
  assert.equal(doc.subtotal, invoice.subtotal)
  assert.equal(doc.gst, invoice.gst)
  assert.equal(doc.gstAmount, invoice.gstAmount)
  assert.equal(doc.discount, invoice.discount)
  assert.equal(doc.grandTotal, invoice.grandTotal)
  assert.equal(doc.paymentStatus, invoice.paymentStatus)

  // Every line keeps its own product, SKU, qty, tax and amount.
  assert.equal(doc.items?.length, 2)
  assert.deepEqual(
    doc.items?.map((i) => [i.product, i.sku, i.qty, i.tax, i.amount]),
    invoice.items.map((i) => [i.product, i.sku, i.qty, i.tax, i.amount]),
  )

  // Live Settings business fields win over the values stamped on the row —
  // same precedence the invoice screen applies.
  const withBusiness = invoicePrintDoc(invoice, {
    business: { businessName: 'Opal Line Jewellers', businessGstin: '33ABCDE1234F1Z5' },
  })
  assert.equal(withBusiness.businessName, 'Opal Line Jewellers')
  assert.equal(withBusiness.businessGstin, '33ABCDE1234F1Z5')
  assert.equal(withBusiness.subtotal, invoice.subtotal, 'business overrides must not touch totals')
})

test('printed totals match the details response and add up to the grand total', () => {
  // The invoice row exactly as /db/invoices/:id + /items would return it.
  const invoice = makeInvoice()
  const html = printInvoice(invoice)

  const taxable = rowValue(html, 'Taxable Value')
  const cgst = rowValue(html, 'CGST @ 1.5%')
  const sgst = rowValue(html, 'SGST @ 1.5%')
  const totalGst = rowValue(html, 'Total GST')
  const discount = rowValue(html, 'Discount')
  const grand = rowValue(html, 'GRAND TOTAL')

  // Taxable Value = GST base = the subtotal on the details screen, never
  // subtotal − discount (the old print subtracted the discount twice).
  assert.equal(taxable, '₹2,350.50')
  assert.equal(rupees(taxable), invoice.subtotal, 'printed taxable value must equal the stored subtotal')
  assert.notEqual(rupees(taxable), invoice.subtotal - invoice.discount, 'discount must not be subtracted here')

  // CGST/SGST are half the STORED GST money, labelled with half the stored rate.
  assert.equal(cgst, '₹35.26')
  assert.equal(sgst, '₹35.26')
  assert.equal(rupees(totalGst), invoice.gstAmount, 'printed GST total must equal the stored gst amount')
  assert.equal(rupees(cgst) + rupees(sgst), invoice.gstAmount)

  assert.equal(discount, '- ₹100.00')
  assert.equal(rupees(discount), invoice.discount)
  assert.equal(grand, '₹2,321.02')
  assert.equal(rupees(grand), invoice.grandTotal, 'printed grand total must equal the stored grand total')

  // The rows on the paper must add up to the printed grand total again.
  assert.equal(
    Math.round((rupees(taxable) + rupees(totalGst) - rupees(discount)) * 100) / 100,
    rupees(grand),
  )

  // The items-table footer total agrees with the details screen's subtotal.
  assert.ok(html.includes(`₹${invoice.subtotal.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`))
})

test('per-line GST prints as money, never as a percentage, and unknown snapshots dash', () => {
  const invoice = makeInvoice()
  const html = printInvoice(invoice)

  // Tax column: ₹ amounts like the screen's Tax column.
  assert.ok(html.includes('₹30.00'), 'ring GST amount must print as ₹30.00')
  assert.ok(html.includes('₹40.52'), 'pendant GST amount must print as ₹40.52')
  assert.ok(!html.includes('30%'), 'a tax amount must never be printed as a percentage')
  assert.ok(!html.includes('40.52%'), 'a tax amount must never be printed as a percentage')

  // Order-raised items carry no silver-rate snapshot: 0 renders as the same
  // dash the invoice screen shows, not a fake ₹0.00.
  assert.ok(!html.includes('₹0.00'), 'unknown rate/making snapshots must not print as ₹0.00')
  assert.ok(html.includes('₹45.00'), 'the real making charge must still print')

  // Percentage labels in the totals box are the GST rate halves only.
  assert.ok(html.includes('CGST @ 1.5%'))
  assert.ok(html.includes('SGST @ 1.5%'))
})

test('every item row keeps its own product, quantity, HSN and amount', () => {
  const invoice = makeInvoice()
  const html = printInvoice(invoice)

  const ringRow = itemRow(html, 'Silver Ring')
  assert.ok(ringRow.includes('SKU-RING-A'), 'ring row must carry the ring SKU')
  assert.ok(ringRow.includes('7113'), 'ring row must carry the ring HSN code')
  assert.ok(ringRow.includes('>2<'), 'ring row must carry the ring quantity')
  assert.ok(ringRow.includes('₹1,000.00'), 'ring row must carry the ring amount')
  assert.ok(ringRow.includes('₹30.00'), 'ring row must carry the ring GST')
  assert.ok(!ringRow.includes('1,350.50'), 'the pendant amount must not leak into the ring row')

  const pendantRow = itemRow(html, 'Gold Pendant')
  assert.ok(pendantRow.includes('SKU-PENDANT-B'), 'pendant row must carry the pendant SKU')
  assert.ok(pendantRow.includes('7114'), 'pendant row must carry the pendant HSN code')
  assert.ok(pendantRow.includes('>1<'), 'pendant row must carry the pendant quantity')
  assert.ok(pendantRow.includes('₹1,350.50'), 'pendant row must carry the pendant amount')
  assert.ok(pendantRow.includes('₹40.52'), 'pendant row must carry the pendant GST')
  assert.ok(!pendantRow.includes('1,000.00'), 'the ring amount must not leak into the pendant row')
})

test('printing is idempotent and never mutates the invoice it prints', () => {
  const invoice = makeInvoice()
  const before = JSON.stringify(invoice)

  const first = printInvoice(invoice)
  const second = printInvoice(invoice)
  assert.equal(first, second, 'the same invoice must render byte-identical HTML every time')

  assert.equal(JSON.stringify(invoice), before, 'building print HTML must not modify the invoice')
})

test('switching to another invoice cannot leak values from the previously printed one', () => {
  const invoiceA = makeInvoice()
  const invoiceB = makeInvoice({
    id: 'inv-print-2',
    number: 'INV-202605109999',
    shopifyOrder: '#T2',
    customer: 'Latha Secondbuyer',
    customerEmail: 'latha@example.com',
    items: [
      { product: 'Nose Pin', sku: 'SKU-NOSE-C', hsn: '7113', qty: 5, weight: 7.5, silverRate: 0, makingCharge: 10, tax: 15, amount: 500 },
    ],
    silverValue: 0,
    makingCharge: 10,
    subtotal: 500,
    gst: 3,
    gstAmount: 15,
    discount: 0,
    grandTotal: 515,
    paymentMethod: 'cod',
    paymentStatus: 'pending',
    status: 'issued',
  })

  const htmlA = printInvoice(invoiceA)
  const htmlB = printInvoice(invoiceB)

  // Invoice B's document must contain none of invoice A's business values.
  for (const leaked of ['Ashok Testbuyer', 'INV-202605101234', 'Silver Ring', 'SKU-RING-A', '2,350.50', '2,321.02', '1,350.50']) {
    assert.ok(!htmlB.includes(leaked), `"${leaked}" from the previous invoice must not appear in the next one`)
  }
  // And B's own values must all be there.
  for (const own of ['Latha Secondbuyer', 'INV-202605109999', 'Nose Pin', 'SKU-NOSE-C', '₹515.00']) {
    assert.ok(htmlB.includes(own), `"${own}" must appear in invoice B's document`)
  }

  // Re-printing A after B still yields A's original document (no shared state).
  assert.equal(printInvoice(invoiceA), htmlA)
})

test('quotations share the same totals block: the discount is subtracted exactly once', () => {
  // The builder is shared with quotations; pin the invariant there too so the
  // taxable-value fix cannot regress one document type while fixing another.
  const quote = makeInvoice({ gstAmount: 0, gst: 0, discount: 150, subtotal: 1200, grandTotal: 1050 })
  const html = buildPrintHtml(invoicePrintDoc(quote), CONFIG, { docType: 'quotation', totalLabel: 'QUOTED TOTAL' })

  const taxable = rowValue(html, 'Taxable Value')
  const discount = rowValue(html, 'Discount')
  const total = rowValue(html, 'QUOTED TOTAL')
  assert.equal(rupees(taxable), 1200, 'taxable value = subtotal, discount gets its own row')
  assert.equal(rupees(discount), 150)
  assert.equal(rupees(total), 1050)
  assert.equal(rupees(taxable) - rupees(discount), rupees(total), 'quoted rows must add up too')
  assert.ok(!html.includes('CGST'), 'a 0% document must not print GST split rows')
})
