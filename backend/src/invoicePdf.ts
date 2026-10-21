import PDFDocument from 'pdfkit'
import QRCode from 'qrcode'
import { getRawClient } from './db/client'
import { logger } from './logger'
import { escapeHtml } from './htmlEscape'

export interface InvoiceItem {
  name: string
  hsn: string
  quantity: number
  grossWeight: number
  netWeight: number
  silverRate: number
  makingCharge: number
  amount: number
  huid?: string | null
}

export interface InvoiceData {
  id: string
  invoiceNumber: string
  date: string
  customerName: string
  customerPhone?: string
  customerEmail?: string
  customerAddress?: string
  customerGstin?: string
  customerState?: string
  customerStateCode?: string
  items: InvoiceItem[]
  subtotal: number
  discount: number
  cgst: number
  sgst: number
  totalGst: number
  grandTotal: number
  amountInWords: string
  businessName: string
  businessAddress: string
  businessGstin: string
  businessState: string
  businessStateCode: string
  businessPhone: string
  businessEmail: string
  paymentMethod: string
  paymentStatus: string
  shopifyOrder?: string
  tdsType?: string
  tdsRate?: number
  tdsAmount?: number
  tdsSection?: string
  adjustedTotal?: number
  upiId?: string
}

// ─── Color palette ────────────────────────────────────────────────
const COLORS = {
  primary: '#1a1a2e',
  accent: '#c8a951',
  border: '#d1d5db',
  lightBg: '#f8f9fa',
  headerBg: '#1a1a2e',
  headerText: '#ffffff',
  text: '#1f2937',
  muted: '#6b7280',
  success: '#059669',
  divider: '#e5e7eb',
}

export function numberToIndianWords(num: number): string {
  if (num === 0) return 'Zero'
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
    'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen']
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety']

  function convert(n: number): string {
    if (n < 20) return ones[n]
    if (n < 100) return tens[Math.floor(n / 10)] + (n % 10 ? ' ' + ones[n % 10] : '')
    if (n < 1000) return ones[Math.floor(n / 100)] + ' Hundred' + (n % 100 ? ' and ' + convert(n % 100) : '')
    if (n < 100000) return convert(Math.floor(n / 1000)) + ' Thousand' + (n % 1000 ? ' ' + convert(n % 1000) : '')
    if (n < 10000000) return convert(Math.floor(n / 100000)) + ' Lakh' + (n % 100000 ? ' ' + convert(n % 100000) : '')
    return convert(Math.floor(n / 10000000)) + ' Crore' + (n % 10000000 ? ' ' + convert(n % 10000000) : '')
  }

  const rupees = Math.floor(num)
  const paise = Math.round((num - rupees) * 100)
  let result = convert(rupees) + ' Rupees'
  if (paise > 0) result += ' and ' + convert(paise) + ' Paise'
  result += ' Only'
  return result
}

/**
 * Currency text safe for PDF drawing.
 *
 * The standard PDF fonts (Helvetica/WinAnsi) have no rupee glyph - pdfkit
 * writes U+20B9 as two stray bytes that render as a superscript-one, turning
 * every money value into unreadable noise. The PDFs therefore print "Rs."
 * while the exported formatCurrency (used by API/UI code and asserted in
 * tests) keeps the rupee sign.
 */
function pdfCurrency(amount: number): string {
  return formatCurrency(amount).replace(String.fromCharCode(0x20b9), 'Rs.')
}

export function formatCurrency(amount: number): string {
  return '\u20B9' + amount.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function drawRoundedRect(doc: PDFKit.PDFDocument, x: number, y: number, w: number, h: number, r: number, fill: string) {
  doc.save()
  doc.roundedRect(x, y, w, h, r).fill(fill)
  doc.restore()
}

export async function generateInvoicePDF(invoiceId: string): Promise<Buffer | null> {
  const client = getRawClient()
  if (!client) return null

  try {
    const invoices = await client.unsafe(`SELECT * FROM sales_invoices WHERE id = $1`, [invoiceId])
    if (invoices.length === 0) return null
    const inv = invoices[0] as any

    const items = await client.unsafe(`SELECT * FROM sales_invoice_items WHERE invoice_id = $1`, [invoiceId])
    const [settings] = await client.unsafe(`SELECT * FROM settings LIMIT 1`) as any[]

    // HUID + HSN lookup: join through SKU so printed invoices carry hallmark
    // numbers and the product's real HSN code (the items table stores neither).
    const skus = items.map((item: any) => String(item.sku || '')).filter(Boolean)
    const huidBySku = new Map<string, string>()
    const hsnBySku = new Map<string, string>()
    if (skus.length > 0) {
      const prods = await client.unsafe(`SELECT sku, huid, hsn FROM products WHERE sku = ANY($1)`, [skus]) as any[]
      for (const p of prods) {
        if (!p.sku) continue
        if (p.huid) huidBySku.set(p.sku, p.huid)
        if (p.hsn) hsnBySku.set(p.sku, p.hsn)
      }
    }

    const itemData: InvoiceItem[] = items.map((item: any) => ({
      // sales_invoice_items.product holds the product name; name/product_name
      // are legacy aliases kept only for rows from older schemas.
      name: item.product || item.name || item.product_name || 'Item',
      hsn: item.hsn || hsnBySku.get(String(item.sku || '')) || '7113',
      quantity: Number(item.qty || item.quantity || 1),
      grossWeight: Number(item.gross_weight || 0),
      netWeight: Number(item.net_weight || item.weight || 0),
      silverRate: Number(item.silver_rate || item.rate || 0),
      makingCharge: Number(item.making_charge || 0),
      amount: Number(item.amount || 0),
      huid: (item.sku && huidBySku.get(item.sku)) || null,
    }))

    const subtotal = Number(inv.subtotal || 0)
    const discount = Number(inv.discount || 0)
    // sales_invoices carries `gst` (the rate, e.g. 3) and `gst_amount` (the
    // money). Use the amount; only compute it when a legacy row lacks one.
    const gstRate = Number(inv.gst || settings?.gst_rate || 3)
    const totalGst = Number(inv.gst_amount || inv.total_gst || (subtotal - discount) * gstRate / 100)
    const cgst = Math.round((totalGst / 2) * 100) / 100
    const sgst = Math.round((totalGst / 2) * 100) / 100
    const grandTotal = Number(inv.grand_total || subtotal - discount + totalGst)

    const tdsType = inv.tds_type || 'none'
    const tdsRate = Number(inv.tds_rate || 0)
    const tdsAmount = Number(inv.tds_amount || 0)
    const tdsSection = inv.tds_section || ''
    const adjustedTotal = tdsType !== 'none' && tdsAmount > 0
      ? Math.round((grandTotal + tdsAmount) * 100) / 100
      : grandTotal
    const hasTds = tdsType !== 'none' && tdsAmount > 0

    const data: InvoiceData = {
      id: inv.id,
      invoiceNumber: inv.number || inv.invoice_number || inv.id,
      date: inv.date ? new Date(inv.date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }),
      customerName: inv.customer_name || inv.customer || 'Walk-in Customer',
      customerPhone: inv.customer_phone || inv.phone || undefined,
      customerEmail: inv.customer_email || inv.email || undefined,
      customerAddress: inv.customer_address || inv.address || undefined,
      // sales_invoices.buyer_gstin is the customer's GSTIN on the row.
      customerGstin: inv.buyer_gstin || inv.customer_gstin || undefined,
      customerState: inv.customer_state || 'Maharashtra',
      customerStateCode: inv.customer_state_code || '27',
      items: itemData,
      subtotal, discount, cgst, sgst, totalGst, grandTotal,
      amountInWords: numberToIndianWords(hasTds ? adjustedTotal : grandTotal),
      businessName: settings?.business_name || 'Opal Line Jewels LLP',
      businessAddress: settings?.address || 'Shop 4, Nariman Point, Mumbai - 400021',
      businessGstin: settings?.gstin || '27AAACO1234F1Z5',
      businessState: 'Maharashtra',
      businessStateCode: '27',
      businessPhone: settings?.phone || '+91 98200 00000',
      businessEmail: settings?.email || 'hello@opalline.in',
      paymentMethod: inv.payment_method || inv.payment || 'Online',
      paymentStatus: inv.payment_status || 'paid',
      shopifyOrder: inv.shopify_order || inv.shopifyOrder || undefined,
      tdsType,
      tdsRate,
      tdsAmount,
      tdsSection,
      adjustedTotal,
      upiId: settings?.upi_id || settings?.upiId || undefined,
    }

    return createPDFBuffer(data)
  } catch (err) {
    logger.error({ err, invoiceId }, 'Invoice PDF generation failed')
    return null
  }
}

export async function createPDFBuffer(data: InvoiceData): Promise<Buffer> {
  // Pre-generate UPI QR code buffer (async) so it's available inside PDFDocument
  let upiQrBuffer: Buffer | null = null
  if (data.upiId) {
    const merchantName = data.businessName.replace(/\s+/g, '+')
    const upiString = `upi://pay?pa=${encodeURIComponent(data.upiId)}&pn=${encodeURIComponent(merchantName)}&am=${data.grandTotal}&cu=INR`
    try {
      const qrDataUrl = await QRCode.toDataURL(upiString, {
        width: 120,
        margin: 1,
        color: { dark: '#1a1a2e', light: '#ffffff' },
      })
      const base64Data = qrDataUrl.replace(/^data:image\/png;base64,/, '')
      upiQrBuffer = Buffer.from(base64Data, 'base64')
    } catch {
      // Will fall back to text rendering
    }
  }

  return new Promise((resolve) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 35, bottom: 35, left: 40, right: 40 },
      info: {
        Title: `Invoice ${data.invoiceNumber}`,
        Author: data.businessName,
        Subject: 'Tax Invoice',
      },
    })
    const chunks: Buffer[] = []
    doc.on('data', (chunk: Buffer) => chunks.push(chunk))
    doc.on('end', () => resolve(Buffer.concat(chunks)))

    const pageW = 595.28 // A4 width in points
    const left = 40
    const right = pageW - 40
    const contentW = right - left

    // ══════════════════════════════════════════════════════════════
    // HEADER — Dark banner with business name
    // ══════════════════════════════════════════════════════════════
    drawRoundedRect(doc, left, 30, contentW, 52, 4, COLORS.headerBg)
    doc.fontSize(20).font('Helvetica-Bold').fillColor(COLORS.headerText)
      .text(data.businessName, left + 16, 38, { width: contentW - 32 })
    doc.fontSize(8).font('Helvetica').fillColor('#a0aec0')
      .text(`${data.businessAddress}`, left + 16, 58, { width: contentW - 32 })
    doc.fontSize(7.5).fillColor('#a0aec0')
      .text(`GSTIN: ${data.businessGstin}  |  State: ${data.businessState} (${data.businessStateCode})  |  Ph: ${data.businessPhone}  |  ${data.businessEmail}`, left + 16, 68, { width: contentW - 32 })

    doc.y = 90

    // ══════════════════════════════════════════════════════════════
    // TAX INVOICE badge + Invoice details
    // ══════════════════════════════════════════════════════════════
    // Badge
    drawRoundedRect(doc, right - 110, 88, 110, 22, 3, COLORS.accent)
    doc.fontSize(10).font('Helvetica-Bold').fillColor(COLORS.primary)
      .text('TAX INVOICE', right - 110, 92, { width: 110, align: 'center' })

    // Invoice info
    doc.fontSize(9).font('Helvetica').fillColor(COLORS.text)
    const infoY = 118
    doc.font('Helvetica-Bold').text('Invoice No:', left, infoY)
    doc.font('Helvetica').text(` ${data.invoiceNumber}`, left + 62, infoY)
    doc.font('Helvetica-Bold').text('Date:', left + 220, infoY)
    doc.font('Helvetica').text(` ${data.date}`, left + 245, infoY)

    doc.font('Helvetica-Bold').text('Payment:', left, infoY + 14)
    doc.font('Helvetica').text(` ${data.paymentMethod} (${data.paymentStatus})`, left + 52, infoY + 14)
    if (data.shopifyOrder) {
      doc.font('Helvetica-Bold').text('Order:', left + 220, infoY + 14)
      doc.font('Helvetica').text(` ${data.shopifyOrder}`, left + 245, infoY + 14)
    }

    doc.y = infoY + 34

    // ══════════════════════════════════════════════════════════════
    // BILL TO / SHIP TO
    // ══════════════════════════════════════════════════════════════
    const billY = doc.y
    drawRoundedRect(doc, left, billY, contentW, 52, 3, COLORS.lightBg)

    doc.fontSize(7).font('Helvetica-Bold').fillColor(COLORS.muted)
      .text('BILL TO', left + 10, billY + 6)
    doc.fontSize(9).font('Helvetica-Bold').fillColor(COLORS.text)
      .text(data.customerName, left + 10, billY + 18, { width: 200 })
    doc.fontSize(8).font('Helvetica').fillColor(COLORS.muted)
    let custDetails = ''
    if (data.customerPhone) custDetails += data.customerPhone
    if (data.customerEmail) custDetails += (custDetails ? '  |  ' : '') + data.customerEmail
    if (custDetails) doc.text(custDetails, left + 10, billY + 32, { width: 200 })
    if (data.customerGstin) doc.text(`GSTIN: ${data.customerGstin}`, left + 10, billY + 44, { width: 200 })

    doc.fontSize(7).font('Helvetica-Bold').fillColor(COLORS.muted)
      .text('STATE', left + 300, billY + 6)
    doc.fontSize(8).font('Helvetica').fillColor(COLORS.text)
      .text(`${data.customerState} (${data.customerStateCode})`, left + 300, billY + 18)

    doc.y = billY + 60

    // ══════════════════════════════════════════════════════════════
    // ITEMS TABLE
    // ══════════════════════════════════════════════════════════════
    doc.y += 4
    const tableTop = doc.y

    // Table header
    drawRoundedRect(doc, left, tableTop, contentW, 18, 2, COLORS.headerBg)
    const cols = [
      { label: 'Description', x: left + 6, w: 140, align: 'left' as const },
      { label: 'HSN', x: left + 150, w: 45, align: 'center' as const },
      { label: 'Qty', x: left + 198, w: 35, align: 'center' as const },
      { label: 'Net Wt (g)', x: left + 236, w: 55, align: 'right' as const },
      { label: 'Rate (Rs./g)', x: left + 294, w: 55, align: 'right' as const },
      { label: 'Making (Rs.)', x: left + 352, w: 60, align: 'right' as const },
      { label: 'Amount (Rs.)', x: left + 416, w: 80, align: 'right' as const },
    ]

    doc.fontSize(7.5).font('Helvetica-Bold').fillColor(COLORS.headerText)
    for (const col of cols) {
      doc.text(col.label, col.x, tableTop + 5, { width: col.w, align: col.align })
    }

    doc.y = tableTop + 22

    // Table rows with alternating backgrounds
    doc.font('Helvetica').fontSize(8).fillColor(COLORS.text)
    for (let i = 0; i < data.items.length; i++) {
      const item = data.items[i]
      const rowY = doc.y
      const rowH = item.huid ? 24 : 16

      // Alternating row background
      if (i % 2 === 0) {
        doc.save()
        doc.rect(left, rowY - 2, contentW, rowH).fill(COLORS.lightBg)
        doc.restore()
      }

      doc.fillColor(COLORS.text)
      doc.text(item.name, cols[0].x, rowY, { width: cols[0].w, align: cols[0].align })
      if (item.huid) {
        doc.fontSize(6.5).fillColor(COLORS.muted).text(`HUID: ${item.huid}`, cols[0].x + 2, rowY + 10, { width: cols[0].w, align: 'left' })
        doc.fontSize(8).fillColor(COLORS.text)
      }
      doc.text(item.hsn, cols[1].x, rowY, { width: cols[1].w, align: cols[1].align })
      doc.text(String(item.quantity), cols[2].x, rowY, { width: cols[2].w, align: cols[2].align })
      doc.text(item.netWeight.toFixed(2), cols[3].x, rowY, { width: cols[3].w, align: cols[3].align })
      // Order-imported items carry no rate/making snapshot; 0 there means
      // "unknown", so print a dash instead of a misleading Rs.0.00.
      const rateText = item.silverRate > 0 ? pdfCurrency(item.silverRate) : '-'
      const makingText = item.makingCharge > 0 ? pdfCurrency(item.makingCharge) : '-'
      doc.text(rateText, cols[4].x, rowY, { width: cols[4].w, align: cols[4].align })
      doc.text(makingText, cols[5].x, rowY, { width: cols[5].w, align: cols[5].align })
      doc.font('Helvetica-Bold').text(pdfCurrency(item.amount), cols[6].x, rowY, { width: cols[6].w, align: cols[6].align })
      doc.font('Helvetica')

      doc.y = rowY + rowH
    }

    // Table bottom border
    doc.save().moveTo(left, doc.y).lineTo(right, doc.y).lineWidth(0.5).stroke(COLORS.border).restore()
    doc.y += 8

    // ══════════════════════════════════════════════════════════════
    // TOTALS — Right-aligned box
    // ══════════════════════════════════════════════════════════════
    const totalsX = left + 300
    const totalsW = contentW - 300
    const totalsY = doc.y

    const hasTds = data.tdsType !== 'none' && (data.tdsAmount ?? 0) > 0
    const boxExtra = hasTds ? 30 : 0
    drawRoundedRect(doc, totalsX, totalsY, totalsW, (data.discount > 0 ? 95 : 80) + boxExtra, 3, COLORS.lightBg)

    const labelX = totalsX + 10
    const valX = totalsX + totalsW - 10
    let ty = totalsY + 8

    const gstRateHalf = data.subtotal > 0 ? ((data.totalGst / (data.subtotal - data.discount)) * 100 / 2).toFixed(1) : '1.5'

    doc.fontSize(8).font('Helvetica').fillColor(COLORS.text)
    doc.text('Taxable Value', labelX, ty, { width: 140 }); doc.text(pdfCurrency(data.subtotal - data.discount), valX - 80, ty, { width: 80, align: 'right' }); ty += 14
    doc.text(`CGST @ ${gstRateHalf}%`, labelX, ty, { width: 140 }); doc.text(pdfCurrency(data.cgst), valX - 80, ty, { width: 80, align: 'right' }); ty += 14
    doc.text(`SGST @ ${gstRateHalf}%`, labelX, ty, { width: 140 }); doc.text(pdfCurrency(data.sgst), valX - 80, ty, { width: 80, align: 'right' }); ty += 14

    if (data.discount > 0) {
      doc.fillColor('#dc2626').text('Discount', labelX, ty, { width: 140 })
      doc.text(`- ${pdfCurrency(data.discount)}`, valX - 80, ty, { width: 80, align: 'right' }); ty += 14
    }

    // Grand total — highlighted
    ty += 2
    doc.save().moveTo(labelX, ty - 2).lineTo(valX, ty - 2).lineWidth(1).stroke(COLORS.accent).restore()
    ty += 4
    doc.fontSize(11).font('Helvetica-Bold').fillColor(COLORS.primary)
    doc.text('GRAND TOTAL', labelX, ty, { width: 140 })
    doc.fillColor(COLORS.accent).text(pdfCurrency(data.grandTotal), valX - 80, ty, { width: 80, align: 'right' })

    if (hasTds) {
      ty += 18
      const label = data.tdsType === 'TDS' ? `TDS (${data.tdsSection || '194Q'})` : `TCS (${data.tdsSection || '206C'})`
      doc.fontSize(9).font('Helvetica').fillColor(COLORS.text)
      doc.text(label, labelX, ty, { width: 140 })
      doc.fillColor('#dc2626').text(`+ ${pdfCurrency(data.tdsAmount!)}`, valX - 80, ty, { width: 80, align: 'right' })
      ty += 16
      doc.save().moveTo(labelX, ty - 2).lineTo(valX, ty - 2).lineWidth(1).stroke(COLORS.accent).restore()
      ty += 4
      doc.fontSize(10).font('Helvetica-Bold').fillColor(COLORS.primary)
      doc.text('TOTAL PAYABLE', labelX, ty, { width: 140 })
      doc.fillColor(COLORS.accent).text(pdfCurrency(data.adjustedTotal!), valX - 80, ty, { width: 80, align: 'right' })
    }

    doc.y = Math.max(doc.y, ty + 20)

    // ══════════════════════════════════════════════════════════════
    // AMOUNT IN WORDS
    // ══════════════════════════════════════════════════════════════
    doc.y += 4
    // Banner grows with the words so long amounts never spill outside the band.
    const wordsWidth = contentW - 110
    const wordsHeight = doc.heightOfString(data.amountInWords, { width: wordsWidth })
    const bannerH = Math.max(20, wordsHeight + 10)
    const bannerY = doc.y
    drawRoundedRect(doc, left, bannerY, contentW, bannerH, 2, '#fef3c7')
    doc.fontSize(7.5).font('Helvetica-Bold').fillColor('#92400e')
      .text('Amount in Words:', left + 8, bannerY + 5)
    doc.fontSize(7.5).font('Helvetica').fillColor('#78350f')
      .text(data.amountInWords, left + 95, bannerY + 5, { width: wordsWidth })

    doc.y = bannerY + bannerH + 8

    // ══════════════════════════════════════════════════════════════
    // DECLARATION + SIGNATURES
    // ══════════════════════════════════════════════════════════════
    doc.save().moveTo(left, doc.y).lineTo(right, doc.y).lineWidth(0.5).stroke(COLORS.divider).restore()
    doc.y += 8

    doc.fontSize(7).font('Helvetica').fillColor(COLORS.muted)
    doc.text('Declaration: We declare that this invoice shows the actual price of the goods described and that all particulars are true and correct. Goods once sold will only be exchanged as per store policy. This is a computer-generated invoice.', left, doc.y, { width: contentW * 0.65 })

    // Signature area
    const sigY = doc.y + 30
    doc.fontSize(8).font('Helvetica').fillColor(COLORS.text)
    doc.text('Customer Signature', left, sigY, { width: 120, align: 'center' })
    doc.save().moveTo(left + 20, sigY + 14).lineTo(left + 100, sigY + 14).lineWidth(0.5).stroke(COLORS.border).restore()

    doc.text(`For ${data.businessName}`, left + contentW - 140, sigY, { width: 140, align: 'center' })
    doc.save().moveTo(left + contentW - 120, sigY + 14).lineTo(left + contentW - 20, sigY + 14).lineWidth(0.5).stroke(COLORS.border).restore()
    doc.fontSize(7).fillColor(COLORS.muted).text('Authorised Signatory', left + contentW - 140, sigY + 18, { width: 140, align: 'center' })

    doc.y = sigY + 35

    // ══════════════════════════════════════════════════════════════
    // UPI QR CODE (bottom-right, if UPI ID configured)
    // ══════════════════════════════════════════════════════════════
    if (data.upiId) {
      const qrSize = 120
      const qrX = right - qrSize - 10
      const qrY = doc.y

      // Bordered box for the QR section
      doc.save()
      doc.roundedRect(qrX - 8, qrY - 4, qrSize + 16, qrSize + 28, 3).lineWidth(0.5).stroke(COLORS.border)
      doc.restore()

      if (upiQrBuffer) {
        doc.image(upiQrBuffer, qrX, qrY, { width: qrSize, height: qrSize })
      } else {
        // Fallback: draw text-based UPI placeholder
        drawRoundedRect(doc, qrX, qrY, qrSize, qrSize, 2, '#f0f0f0')
        doc.fontSize(7).font('Helvetica').fillColor(COLORS.text)
          .text(`UPI: ${data.upiId}`, qrX + 4, qrY + 30, { width: qrSize - 8, align: 'center' })
        doc.text(`Rs.${data.grandTotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`, qrX + 4, qrY + 44, { width: qrSize - 8, align: 'center' })
      }

      // Label below QR
      doc.fontSize(6).font('Helvetica').fillColor(COLORS.muted)
        .text('Scan to pay via UPI', qrX - 8, qrY + qrSize + 6, { width: qrSize + 16, align: 'center' })
    }

    // ══════════════════════════════════════════════════════════════
    // FOOTER
    // ══════════════════════════════════════════════════════════════
    doc.save().moveTo(left, doc.y).lineTo(right, doc.y).lineWidth(0.3).stroke(COLORS.divider).restore()
    doc.y += 6
    doc.fontSize(6.5).font('Helvetica').fillColor(COLORS.muted)
      .text(`Generated by ${data.businessName} ERP  |  opalline.in  |  This is a computer-generated invoice`, left, doc.y, { width: contentW, align: 'center' })

    doc.end()
  })
}

export async function emailInvoicePDF(invoiceId: string, recipientEmail: string): Promise<boolean> {
  const { sendEmail } = await import('./notifications')
  const pdfBuffer = await generateInvoicePDF(invoiceId)
  if (!pdfBuffer) return false

  const client = getRawClient()
  if (!client) return false

  const [inv] = await client.unsafe(`SELECT invoice_number FROM sales_invoices WHERE id = $1`, [invoiceId]) as any[]
  const invNumber = inv?.invoice_number || invoiceId

  return sendEmail({
    to: recipientEmail,
    subject: `Invoice ${invNumber} — Opal Line`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <h2 style="color: #1a1a2e;">\uD83D\uDCC4 Invoice ${escapeHtml(invNumber)}</h2>
        <p>Please find your invoice attached. You can also download it from the ERP.</p>
        <p style="color: #999; font-size: 12px;">Opal Line ERP — Invoice Notification</p>
      </div>
    `,
    attachments: [{ filename: `${invNumber}.pdf`, content: pdfBuffer }],
  })
}