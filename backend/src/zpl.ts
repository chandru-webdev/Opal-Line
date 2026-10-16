// Safe ZPL (Zebra Programming Language) label renderer.
//
// The supplied reference `.prn` files are Zebra ZPL authored at 203 dpi
// (8 dots/mm) and print a QR symbol with `^BQN` encoding the product code. This
// module reproduces that command set for the four physical sizes.
//
// Safety properties:
//  - one `^XA … ^XZ` block per physical label, so labels can never be clipped or
//    overlapped the way a hand-written multi-up template can be;
//  - every text field is escaped (`^`, `~`, `\` via `^FH\` hex escapes) so a
//    product name can never inject a ZPL command;
//  - label dimensions are validated (1–200 mm) before any command is emitted;
//  - copies use the printer's own `^PQ` counter rather than repeating blocks.
//
// This renderer only produces text. It is never sent directly to a raw printer
// port — the caller decides how to deliver it (file download for a ZPL-capable
// printer / print server), so a browser can never be asked to open a socket.

import { labelCode, LABEL_PRESETS, type ProductLabel } from './barcodeLabels'

export const ZPL_DOTS_PER_MM = 8
export const ZPL_MAX_MM = 200

export type ZplSymbology = 'qr' | 'code128'

export interface ZplOptions {
  width: number        // mm
  height: number       // mm
  copies?: number
  symbology?: ZplSymbology
  brand?: string
  showPrice?: boolean
}

export interface ZplLabelInput extends ProductLabel {}

/** Reason the requested dimensions cannot be printed, or null when valid. */
export function zplDimensionError(width: number, height: number): string | null {
  for (const [name, value] of [['width', width], ['height', height]] as const) {
    if (!Number.isFinite(value) || value <= 0) return `Label ${name} must be a positive number of millimetres`
    if (value > ZPL_MAX_MM) return `Label ${name} must be ${ZPL_MAX_MM} mm or less`
  }
  return null
}

/**
 * Escape a text field for use after `^FH\`. The three characters that can start
 * a ZPL command (`^`, `~`) or the hex-escape introducer itself (`\`) are emitted
 * as `\xx` hex pairs; other non-printable/non-ASCII characters become `?` so the
 * byte stream stays safe with `^CI28` (UTF-8) set.
 */
export function zplEscape(text: unknown): string {
  let out = ''
  for (const ch of String(text ?? '')) {
    const code = ch.codePointAt(0) ?? 0
    if (ch === '\\') { out += '\\5C'; continue }
    if (ch === '^') { out += '\\5E'; continue }
    if (ch === '~') { out += '\\7E'; continue }
    if (code < 0x20 || code > 0x7e) { out += '?'; continue }
    out += ch
  }
  return out
}

function mmToDots(mm: number): number {
  return Math.max(1, Math.round(mm * ZPL_DOTS_PER_MM))
}

function formatRate(price: number): string {
  const value = Number.isFinite(price) ? price : 0
  return `Rate: ${value.toFixed(2)}/-`
}

interface ZplGeometry {
  widthDots: number
  heightDots: number
  pad: number
  qrSize: number
  qrX: number
  qrY: number
  textWidth: number
  brandFont: number
  nameFont: number
  rateFont: number
  codeFont: number
}

function computeGeometry(width: number, height: number): ZplGeometry {
  const widthDots = mmToDots(width)
  const heightDots = mmToDots(height)
  const pad = Math.round(Math.min(widthDots, heightDots) * 0.06)
  const qrSize = Math.min(heightDots - pad * 2, Math.round(widthDots * 0.42))
  return {
    widthDots,
    heightDots,
    pad,
    qrSize,
    qrX: widthDots - pad - qrSize,
    qrY: heightDots - pad - qrSize,
    textWidth: Math.max(widthDots - 2 * pad - (qrSize > 0 ? qrSize + pad : 0), 8),
    brandFont: Math.max(12, Math.round(heightDots * 0.15)),
    nameFont: Math.max(10, Math.round(heightDots * 0.10)),
    rateFont: Math.max(12, Math.round(heightDots * 0.15)),
    codeFont: Math.max(9, Math.round(heightDots * 0.085)),
  }
}

/** Content for a single ZPL label block. Exported for tests. */
export function zplLabel(product: ZplLabelInput, options: ZplOptions): string | null {
  const error = zplDimensionError(options.width, options.height)
  if (error) return null

  const g = computeGeometry(options.width, options.height)
  const symbology: ZplSymbology = options.symbology === 'code128' ? 'code128' : 'qr'
  const copies = Math.min(Math.max(Math.floor(options.copies ?? 1) || 1, 1), 999)
  const code = zplEscape(labelCode(product))
  const brand = zplEscape((options.brand ?? 'Opal Line').trim())
  const name = zplEscape(product.name || 'Product')

  const lines: string[] = []
  lines.push('^XA')
  lines.push('^CI28')
  lines.push(`^PW${g.widthDots}`)
  lines.push(`^LL${g.heightDots}`)
  lines.push('^LH0,0')

  // Text stack on the left, mirroring the reference order.
  let y = g.pad + g.brandFont
  if (brand) lines.push(`^FT${g.pad},${y}^A0N,${g.brandFont},${g.brandFont}^FH\\^FD${brand}^FS`)
  y += Math.round(g.nameFont * 1.4) + Math.round(g.brandFont * 0.3)
  lines.push(`^FT${g.pad},${y}^A0N,${g.nameFont},${g.nameFont}^FH\\^FD${name}^FS`)
  if (options.showPrice !== false) {
    y += Math.round(g.rateFont * 1.5)
    lines.push(`^FT${g.pad},${y}^A0N,${g.rateFont},${g.rateFont}^FH\\^FD${zplEscape(formatRate(product.price))}^FS`)
  }
  if (code) {
    y += Math.round(g.codeFont * 1.7)
    const label = options.height <= 12 ? code : `Code: ${code}`
    lines.push(`^FT${g.pad},${y}^A0N,${g.codeFont},${g.codeFont}^FH\\^FD${label}^FS`)
  }

  // Scannable symbol, bottom-right (reference placement).
  if (code) {
    if (symbology === 'qr') {
      const mag = Math.min(10, Math.max(2, Math.floor(g.qrSize / 30)))
      lines.push(`^FT${g.qrX},${g.qrY + g.qrSize}^BQN,2,${mag}`)
      lines.push(`^FH\\^FDLA,${code}^FS`)
    } else {
      const barH = Math.max(20, g.qrSize - 12)
      lines.push(`^FT${g.qrX},${g.qrY + g.qrSize}^BCN,${barH},Y,N,N`)
      lines.push(`^FH\\^FD${code}^FS`)
    }
  }

  lines.push(`^PQ${copies},0,1,Y`)
  lines.push('^XZ')
  return lines.join('\n')
}

/** Render one ZPL block per label. Returns '' when nothing can be rendered. */
export function renderZpl(products: ZplLabelInput[], options: ZplOptions): string {
  if (products.length === 0) return ''
  if (zplDimensionError(options.width, options.height)) return ''
  const blocks: string[] = []
  for (const product of products) {
    const block = zplLabel(product, options)
    if (block) blocks.push(block)
  }
  return blocks.join('\n')
}

/** Build options from a preset key, so callers share one source of dimensions. */
export function zplOptionsForPreset(preset: string | undefined, overrides: Partial<ZplOptions> = {}): ZplOptions {
  const base = LABEL_PRESETS[preset ?? ''] ?? LABEL_PRESETS['label-50x40'] ?? { width: 50, height: 40 }
  return {
    width: (overrides.width ?? (base as { width?: number }).width ?? 50),
    height: (overrides.height ?? (base as { height?: number }).height ?? 40),
    copies: overrides.copies ?? 1,
    symbology: overrides.symbology ?? 'qr',
    brand: overrides.brand ?? 'Opal Line',
    showPrice: overrides.showPrice ?? true,
  }
}
