import QRCode from 'qrcode'
import PDFDocument from 'pdfkit'
import { getRawClient } from './db/client'
import { logger } from './logger'

export interface ProductLabel {
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
  showBrand: boolean
  brand: string
  copies: number
}

const DEFAULT_OPTIONS: LabelOptions = {
  width: 50,
  height: 40,
  columns: 4,
  rows: 7,
  showPrice: true,
  showWeight: true,
  showQR: true,
  showBarcode: true,
  showBrand: true,
  brand: 'Opal Line',
  copies: 1,
}

// ─── Label presets ────────────────────────────────────────────────
// `columns`/`rows` describe how many labels are laid out per A4 sheet; they are
// derived from the physical label size so the grid always fits the page.
//
// The four reference sizes supplied by the store (50×40, 50×25, 50×10, 35×22)
// are listed first. The remaining entries are kept for backwards compatibility
// with label stock already in use.
export const LABEL_PRESETS: Record<string, Partial<LabelOptions>> = {
  // Requested reference sizes
  'label-50x40': { width: 50, height: 40, columns: 4, rows: 7 },
  'label-50x25': { width: 50, height: 25, columns: 4, rows: 11 },
  'label-35x22': { width: 35, height: 22, columns: 5, rows: 13 },
  'label-50x10': { width: 50, height: 10, columns: 4, rows: 28 },
  // Existing sizes (kept for backwards compatibility)
  'label-50x22': { width: 50, height: 22, columns: 4, rows: 13 },
  'avery-5160': { width: 63.5, height: 25.4, columns: 3, rows: 10 },
  'avery-8160': { width: 38.1, height: 21.2, columns: 4, rows: 12 },
  'dymo-30256': { width: 51, height: 25, columns: 3, rows: 8 },
  'zlabel-50x30': { width: 50, height: 30, columns: 4, rows: 7 },
  'zlabel-40x25': { width: 40, height: 25, columns: 4, rows: 8 },
}

export interface LabelPresetMeta {
  key: string
  label: string
  width: number
  height: number
  columns: number
  rows: number
  /** The four sizes supplied as physical design references. */
  reference: boolean
}

const REFERENCE_PRESETS = ['label-50x40', 'label-50x25', 'label-50x10', 'label-35x22']

/** Ordered preset list (reference sizes first) for the print UI. */
export const LABEL_PRESET_LIST: LabelPresetMeta[] = Object.entries(LABEL_PRESETS).map(([key, val]) => {
  const v = val as LabelOptions
  return {
    key,
    label: `${v.width} × ${v.height} mm`,
    width: v.width,
    height: v.height,
    columns: v.columns,
    rows: v.rows,
    reference: REFERENCE_PRESETS.includes(key),
  }
})

export const DEFAULT_PRESET = 'label-50x40'

/** Resolve a preset key to a full options object, defaulting unknown keys. */
export function resolveLabelPreset(preset: string | undefined, overrides: Partial<LabelOptions> = {}): LabelOptions {
  const base = LABEL_PRESETS[preset ?? ''] ?? LABEL_PRESETS[DEFAULT_PRESET] ?? {}
  const merged = { ...DEFAULT_OPTIONS, ...base, ...overrides }
  // `brand` may arrive as `businessName` from older callers.
  const businessName = (overrides as { businessName?: string }).businessName
  if (businessName && !overrides.brand) merged.brand = businessName
  merged.copies = Math.min(Math.max(Math.floor(Number(merged.copies) || 1), 1), 999)
  return merged
}

function mapRow(p: any): ProductLabel {
  return {
    name: p.name || 'Product',
    sku: p.sku || '',
    barcode: p.barcode || undefined,
    price: Number(p.selling_price || 0),
    weight: Number(p.net_weight || 0),
    category: p.category || undefined,
    hsn: p.hsn || '7113',
    huid: p.huid || undefined,
  }
}

export async function fetchProductLabels(productIds: string[]): Promise<ProductLabel[]> {
  const client = getRawClient()
  if (!client || productIds.length === 0) return []
  try {
    const products = await client.unsafe(
      `SELECT name, sku, barcode, selling_price, net_weight, category, hsn, huid FROM products WHERE id = ANY($1)`,
      [productIds]
    )
    // Preserve the caller's order — the printed sheet should match the order the
    // operator selected, not whatever order the database returns.
    const byId = new Map<string, ProductLabel>()
    for (const p of products) byId.set(p.id, mapRow(p))
    return productIds.map((id) => byId.get(id)).filter((p): p is ProductLabel => Boolean(p))
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
    return products.map(mapRow)
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

/**
 * The identifier a label encodes. Prefer the product's stable barcode; fall back
 * to the SKU so a label is never printed with an empty scannable code.
 */
export function labelCode(product: Pick<ProductLabel, 'barcode' | 'sku'>): string {
  return (product.barcode && product.barcode.trim()) || (product.sku ?? '').trim()
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
// Deriving everything from the real label width/height (instead of hard-coded
// offsets) is what lets one renderer fill 50×40, 50×25, 35×22 and 50×10 without
// clipping, overflow or scaling artifacts.
//
// The scannable code sits on the RIGHT and the text column on the LEFT, matching
// the supplied ZPL reference labels.

export interface LabelGeometry {
  pad: number
  innerW: number
  innerH: number
  qrSize: number
  qrGap: number
  qrX: number       // left offset of the code, from the label's left edge
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
  const textX = pad
  const textWidth = Math.max(innerW - (qrSize > 0 ? qrSize + qrGap : 0), 8)
  const qrX = qrSize > 0 ? pad + innerW - qrSize : 0

  return { pad, innerW, innerH, qrSize, qrGap, qrX, textX, textWidth }
}

export type LabelLineKind = 'brand' | 'name' | 'code' | 'category' | 'price' | 'weight'

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
  barcode?: string
  price: number
  weight?: number
  category?: string
}

export interface LabelLineOptions {
  showPrice: boolean
  showWeight: boolean
  showBrand?: boolean
  brand?: string
  /** On very short labels the "Code:" prefix wastes room — drop it. */
  compact?: boolean
}

const LINE_HEIGHT = 1.15

/** Format the reference "Rate: 99999.00/-" string from a numeric price. */
export function formatLabelRate(price: number): string {
  const value = Number.isFinite(price) ? price : 0
  return `Rate: ${value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}/-`
}

export function computeLabelLines(
  geometry: LabelGeometry,
  product: LabelLineInput,
  opts: LabelLineOptions,
): LabelLine[] {
  const { pad, innerH } = geometry

  // Font sizes scale with the label height, so text stays proportional on every
  // size and is clamped so it never becomes illegibly small or oversized.
  const metaSize = clamp(innerH * 0.15, 3, 5.5)
  const nameSize = clamp(innerH * 0.20, 3.5, 7)
  const brandSize = clamp(innerH * 0.24, 3.8, 8.5)
  const priceSize = clamp(innerH * 0.26, 4.5, 9)
  const categorySize = Math.max(metaSize * 0.9, 2.8)

  const priceH = priceSize * LINE_HEIGHT
  const weightSize = metaSize
  const weightH = weightSize * LINE_HEIGHT
  const hasWeight = opts.showWeight && !!product.weight
  const bottomH = Math.max(opts.showPrice ? priceH : 0, hasWeight ? weightH : 0)
  const gap = Math.max(1.5, pad * 0.5)
  const topAvail = Math.max(innerH - bottomH - gap, 0)

  const code = labelCode(product)
  const showBrand = opts.showBrand !== false && !!opts.brand && !opts.compact

  // Top stack, in reference order: brand, name, code, category. `name` is
  // protected — the optional lines are dropped from the *bottom* of this list
  // until the block fits, so a tiny label keeps brand + name + price.
  const stack: Array<{ kind: LabelLineKind; text: string; size: number }> = []
  if (showBrand) stack.push({ kind: 'brand', text: opts.brand as string, size: brandSize })
  if (product.name) stack.push({ kind: 'name', text: product.name, size: nameSize })
  if (code) {
    stack.push({ kind: 'code', text: opts.compact ? code : `Code: ${code}`, size: metaSize })
  }
  if (product.category && !opts.compact) {
    stack.push({ kind: 'category', text: product.category, size: categorySize })
  }

  const droppable = new Set<LabelLineKind>(['brand', 'code', 'category'])
  const total = () => stack.reduce((sum, c) => sum + c.size * LINE_HEIGHT, 0)
  while (total() > topAvail) {
    let idx = -1
    for (let i = stack.length - 1; i >= 0; i--) {
      if (droppable.has(stack[i].kind)) { idx = i; break }
    }
    if (idx === -1) break
    stack.splice(idx, 1)
  }

  const lines: LabelLine[] = []
  let y = pad
  for (const c of stack) {
    const height = c.size * LINE_HEIGHT
    lines.push({ kind: c.kind, text: c.text, fontSize: c.size, y, height, align: 'left' })
    y += height
  }

  // Price pinned to the bottom-left, weight to the bottom-right, on one baseline.
  if (opts.showPrice) {
    lines.push({
      kind: 'price',
      text: formatLabelRate(product.price),
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
  brand: { font: 'Helvetica-Bold', color: '#111827' },
  name: { font: 'Helvetica-Bold', color: '#1f2937' },
  code: { font: 'Helvetica', color: '#6b728b' },
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

  // Scannable code on the right, vertically centred (reference placement).
  if (opts.showQR && qrBuffer && geometry.qrSize > 0) {
    const qrY = actualY + geometry.pad + Math.max((geometry.innerH - geometry.qrSize) / 2, 0)
    doc.image(qrBuffer, actualX + geometry.qrX, qrY, {
      width: geometry.qrSize,
      height: geometry.qrSize,
    })
  }

  // Text on the left, laid out from the computed geometry so it always stays
  // inside the label for any of the supported sizes.
  const lines = computeLabelLines(
    geometry,
    {
      name: product.name,
      sku: product.sku,
      barcode: product.barcode,
      price: product.price,
      weight: product.weight,
      category: product.category,
    },
    {
      showPrice: opts.showPrice,
      showWeight: opts.showWeight,
      showBrand: opts.showBrand,
      brand: opts.brand,
      compact: opts.height <= 12,
    },
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

  const opts = resolveLabelPreset(undefined, { ...options } as Partial<LabelOptions>)
  // Honour an explicit preset key too (callers pass either the preset name or a
  // full width/height); resolveLabelPreset already merged the direct fields.
  const presetKey = (options as { preset?: string }).preset
  const resolved = presetKey ? resolveLabelPreset(presetKey, options) : opts

  const labelW = mmToPt(resolved.width)
  const labelH = mmToPt(resolved.height)
  const geometry = computeLabelGeometry(labelW, labelH, resolved.showQR)

  const copies = Math.min(Math.max(Math.floor(resolved.copies) || 1, 1), 999)
  const expanded: ProductLabel[] = []
  for (const product of products) for (let i = 0; i < copies; i++) expanded.push(product)

  // Pre-generate all QR codes at the exact size the layout will draw them.
  const qrBuffers: (Buffer | null)[] = []
  if (resolved.showQR && geometry.qrSize > 0) {
    for (const product of expanded) {
      qrBuffers.push(await generateQRBuffer(labelCode(product), geometry.qrSize))
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

    for (let i = 0; i < expanded.length; i++) {
      const product = expanded[i]

      // Check if we need a new page
      if (row >= resolved.rows) {
        doc.addPage()
        col = 0
        row = 0
      }

      const actualY = startY + row * labelH
      const actualX = startX + col * labelW

      drawLabel(doc, product, actualX, actualY, labelW, labelH, geometry, resolved, qrBuffers[i] ?? null)

      // Advance position
      col++
      if (col >= resolved.columns) {
        col = 0
        row++
      }
    }

    doc.end()
  }) as any
}
