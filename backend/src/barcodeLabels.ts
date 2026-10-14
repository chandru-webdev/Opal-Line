import QRCode from 'qrcode'
import PDFDocument from 'pdfkit'
import { getRawClient } from './db/client'
import { logger } from './logger'

interface ProductLabel {
  name: string
  sku: string
  barcode?: string
  price: number
  weight?: number
  category?: string
  hsn?: string
  huid?: string
}

interface LabelOptions {
  width: number       // mm
  height: number      // mm
  columns: number
  rows: number
  showPrice: boolean
  showWeight: boolean
  showQR: boolean
  showBarcode: boolean
  businessName: string
}

const DEFAULT_OPTIONS: LabelOptions = {
  width: 50,
  height: 30,
  columns: 4,
  rows: 7,
  showPrice: true,
  showWeight: true,
  showQR: true,
  showBarcode: true,
  businessName: 'Opal Line',
}

// ─── Common label sizes ───────────────────────────────────────────
// `columns`/`rows` describe how many labels are laid out per A4 sheet; they are
// derived from the physical label size so the grid always fits the page.
export const LABEL_PRESETS: Record<string, Partial<LabelOptions>> = {
  // Requested standard sizes
  'label-50x25': { width: 50, height: 25, columns: 4, rows: 11 },
  'label-50x22': { width: 50, height: 22, columns: 4, rows: 13 },
  'label-35x22': { width: 35, height: 22, columns: 5, rows: 13 },
  'label-50x10': { width: 50, height: 10, columns: 4, rows: 28 },
  // Existing sizes (kept for backwards compatibility)
  'avery-5160': { width: 63.5, height: 25.4, columns: 3, rows: 10 },
  'avery-8160': { width: 38.1, height: 21.2, columns: 4, rows: 12 },
  'dymo-30256': { width: 51, height: 25, columns: 3, rows: 8 },
  'zlabel-50x30': { width: 50, height: 30, columns: 4, rows: 7 },
  'zlabel-40x25': { width: 40, height: 25, columns: 4, rows: 8 },
}

export async function fetchProductLabels(productIds: string[]): Promise<ProductLabel[]> {
  const client = getRawClient()
  if (!client) return []
  try {
    const products = await client.unsafe(
      `SELECT name, sku, barcode, selling_price, net_weight, category, hsn, huid FROM products WHERE id = ANY($1)`,
      [productIds]
    )
    return products.map((p: any) => ({
      name: p.name || 'Product',
      sku: p.sku || '',
      barcode: p.barcode || undefined,
      price: Number(p.selling_price || 0),
      weight: Number(p.net_weight || 0),
      category: p.category || undefined,
      hsn: p.hsn || '7113',
      huid: p.huid || undefined,
    }))
  } catch (err) {
    logger.error({ err }, 'Failed to fetch product labels')
    return []
  }
}

export async function fetchAllProductLabels(): Promise<ProductLabel[]> {
  const client = getRawClient()
  if (!client) return []
  try {
    const products = await client.unsafe(
      `SELECT name, sku, barcode, selling_price, net_weight, category, hsn, huid FROM products ORDER BY name`
    )
    return products.map((p: any) => ({
      name: p.name || 'Product',
      sku: p.sku || '',
      barcode: p.barcode || undefined,
      price: Number(p.selling_price || 0),
      weight: Number(p.net_weight || 0),
      category: p.category || undefined,
      hsn: p.hsn || '7113',
      huid: p.huid || undefined,
    }))
  } catch (err) {
    logger.error({ err }, 'Failed to fetch all product labels')
    return []
  }
}

function mmToPt(mm: number): number {
  return (mm / 25.4) * 72
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

async function generateQRBuffer(data: string, size: number): Promise<Buffer | null> {
  try {
    return await QRCode.toBuffer(data, {
      width: Math.max(1, Math.round(size)),
      margin: 0,
      // Short labels leave the code very little room. A lower error-correction
      // level keeps the module count (and therefore each physical module) as
      // large as possible, which is what keeps a tiny code scanable.
      errorCorrectionLevel: size < 32 ? 'L' : 'M',
      color: { dark: '#1a1a2e', light: '#ffffff' },
    })
  } catch {
    return null
  }
}

// ─── Adaptive label layout ────────────────────────────────────────
// All measurements are PDF points relative to the label's own top-left corner.
// Deriving everything from the real label width/height (instead of the old
// hard-coded offsets) is what lets one renderer fill 50×25, 50×22, 35×22 and
// 50×10 without clipping, overflow or scaling artifacts.

export interface LabelGeometry {
  pad: number
  innerW: number
  innerH: number
  qrSize: number
  qrGap: number
  textX: number
  textWidth: number
}

export function computeLabelGeometry(labelW: number, labelH: number, showQR: boolean): LabelGeometry {
  const pad = clamp(Math.min(labelH * 0.08, labelW * 0.035), 2.5, 5)
  const innerW = labelW - pad * 2
  const innerH = labelH - pad * 2

  let qrSize = 0
  let qrGap = 0
  if (showQR && innerH >= 8) {
    // Never taller than the label, never wider than ~45% of it (so the text
    // keeps its room), capped at 50pt to preserve the look on large labels.
    qrSize = Math.min(innerH, innerW * 0.45, 50)
    qrGap = Math.max(3, pad * 0.6)
  }
  const textX = pad + (qrSize > 0 ? qrSize + qrGap : 0)
  const textWidth = Math.max(innerW - (qrSize > 0 ? qrSize + qrGap : 0), 8)

  return { pad, innerW, innerH, qrSize, qrGap, textX, textWidth }
}

export type LabelLineKind = 'name' | 'sku' | 'huid' | 'category' | 'price' | 'weight'

export interface LabelLine {
  kind: LabelLineKind
  text: string
  fontSize: number
  y: number       // top offset from the label's top edge, in points
  height: number  // line box height, in points
  align: 'left' | 'right'
}

export interface LabelLineInput {
  name: string
  sku: string
  price: number
  weight?: number
  category?: string
  huid?: string
}

export interface LabelLineOptions {
  showPrice: boolean
  showWeight: boolean
}

const LINE_HEIGHT = 1.15

export function computeLabelLines(
  geometry: LabelGeometry,
  product: LabelLineInput,
  opts: LabelLineOptions,
): LabelLine[] {
  const { pad, innerH } = geometry

  // Font sizes scale with the label height, so text stays proportional on every
  // size and is clamped so it never becomes illegibly small or oversized.
  const metaSize = clamp(innerH * 0.15, 3, 5.5)
  const nameSize = clamp(innerH * 0.22, 3.5, 7.5)
  const priceSize = clamp(innerH * 0.28, 4.5, 9.5)
  const categorySize = Math.max(metaSize * 0.9, 2.8)

  const priceH = priceSize * LINE_HEIGHT
  const weightSize = metaSize
  const weightH = weightSize * LINE_HEIGHT
  const hasWeight = opts.showWeight && !!product.weight
  const bottomH = Math.max(opts.showPrice ? priceH : 0, hasWeight ? weightH : 0)
  const gap = Math.max(1.5, pad * 0.5)
  const topAvail = innerH - bottomH - gap

  // Fields stacked from the top. Priority is top→bottom: the last entry is the
  // first to be dropped when a short label cannot fit them all at a legible
  // size (name and price are always kept). This prevents any clipping/overflow.
  const candidates: Array<{ kind: LabelLineKind; text: string; size: number }> = []
  if (product.name) candidates.push({ kind: 'name', text: product.name, size: nameSize })
  if (product.sku) candidates.push({ kind: 'sku', text: `SKU: ${product.sku}`, size: metaSize })
  if (product.huid) candidates.push({ kind: 'huid', text: `HUID: ${product.huid}`, size: metaSize })
  if (product.category) candidates.push({ kind: 'category', text: product.category, size: categorySize })

  const totalHeight = (list: typeof candidates) => list.reduce((sum, c) => sum + c.size * LINE_HEIGHT, 0)
  const fitted = candidates.slice()
  while (fitted.length > 1 && totalHeight(fitted) > topAvail) fitted.pop()

  const lines: LabelLine[] = []
  let y = pad
  for (const c of fitted) {
    const height = c.size * LINE_HEIGHT
    lines.push({ kind: c.kind, text: c.text, fontSize: c.size, y, height, align: 'left' })
    y += height
  }

  // Price and weight are pinned to the bottom, on one shared baseline.
  if (opts.showPrice) {
    lines.push({
      kind: 'price',
      text: `\u20B9${product.price.toLocaleString('en-IN')}`,
      fontSize: priceSize,
      y: pad + innerH - priceH,
      height: priceH,
      align: 'left',
    })
  }
  if (hasWeight) {
    lines.push({
      kind: 'weight',
      text: `${product.weight}g`,
      fontSize: weightSize,
      y: pad + innerH - weightH,
      height: weightH,
      align: 'right',
    })
  }

  return lines
}

const LINE_STYLE: Record<LabelLineKind, { font: 'Helvetica' | 'Helvetica-Bold'; color: string }> = {
  name: { font: 'Helvetica-Bold', color: '#1f2937' },
  sku: { font: 'Helvetica', color: '#6b728b' },
  huid: { font: 'Helvetica-Bold', color: '#b45309' },
  category: { font: 'Helvetica', color: '#9ca3af' },
  price: { font: 'Helvetica-Bold', color: '#059669' },
  weight: { font: 'Helvetica', color: '#6b728b' },
}

// Truncate with an ellipsis to the exact pixel width of the active font, so a
// long name/SKU can never spill outside its label.
function fitText(doc: PDFKit.PDFDocument, text: string, maxWidth: number): string {
  if (maxWidth <= 0 || doc.widthOfString(text) <= maxWidth) return text
  const ellipsis = '\u2026'
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (doc.widthOfString(text.slice(0, mid) + ellipsis) <= maxWidth) lo = mid
    else hi = mid - 1
  }
  return text.slice(0, lo) + ellipsis
}

function drawLabel(
  doc: PDFKit.PDFDocument,
  product: ProductLabel,
  actualX: number,
  actualY: number,
  labelW: number,
  labelH: number,
  geometry: LabelGeometry,
  opts: LabelOptions,
  qrBuffer: Buffer | null,
): void {
  // Border
  doc.save()
  doc.roundedRect(actualX + 1, actualY + 1, labelW - 2, labelH - 2, 2).lineWidth(0.3).stroke('#e5e7eb')
  doc.restore()

  // QR code (the scannable element) on the left.
  if (opts.showQR && qrBuffer && geometry.qrSize > 0) {
    doc.image(qrBuffer, actualX + geometry.pad, actualY + geometry.pad, {
      width: geometry.qrSize,
      height: geometry.qrSize,
    })
  }

  // Text on the right, laid out from the computed geometry so it always stays
  // inside the label for any of the supported sizes.
  const lines = computeLabelLines(
    geometry,
    {
      name: product.name,
      sku: product.sku,
      price: product.price,
      weight: product.weight,
      category: product.category,
      huid: product.huid,
    },
    { showPrice: opts.showPrice, showWeight: opts.showWeight },
  )

  const x = actualX + geometry.textX
  for (const line of lines) {
    const style = LINE_STYLE[line.kind]
    doc.font(style.font).fontSize(line.fontSize).fillColor(style.color)
    const text = fitText(doc, line.text, geometry.textWidth)
    doc.text(text, x, actualY + line.y, {
      width: geometry.textWidth,
      height: line.height,
      align: line.align,
      lineBreak: false,
      ellipsis: true,
    })
  }
}

export async function generateLabelsPDF(
  products: ProductLabel[],
  options: Partial<LabelOptions> = {}
): Promise<Buffer | null> {
  if (products.length === 0) return null

  const opts = { ...DEFAULT_OPTIONS, ...options }
  const labelW = mmToPt(opts.width)
  const labelH = mmToPt(opts.height)
  const geometry = computeLabelGeometry(labelW, labelH, opts.showQR)

  // Pre-generate all QR codes at the exact size the layout will draw them.
  const qrBuffers: (Buffer | null)[] = []
  if (opts.showQR && geometry.qrSize > 0) {
    for (const product of products) {
      const qrData = JSON.stringify({ sku: product.sku, name: product.name, price: product.price })
      qrBuffers.push(await generateQRBuffer(qrData, geometry.qrSize))
    }
  }

  return new Promise((resolve) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 20, bottom: 20, left: 20, right: 20 },
    })
    const chunks: Buffer[] = []
    doc.on('data', (chunk: Buffer) => chunks.push(chunk))
    doc.on('end', () => resolve(Buffer.concat(chunks)))

    const startX = 20
    const startY = 20
    let col = 0
    let row = 0

    for (let i = 0; i < products.length; i++) {
      const product = products[i]

      // Check if we need a new page
      if (row >= opts.rows) {
        doc.addPage()
        col = 0
        row = 0
      }

      const actualY = startY + row * labelH
      const actualX = startX + col * labelW

      drawLabel(doc, product, actualX, actualY, labelW, labelH, geometry, opts, qrBuffers[i] ?? null)

      // Advance position
      col++
      if (col >= opts.columns) {
        col = 0
        row++
      }
    }

    doc.end()
  }) as any
}