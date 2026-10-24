import type { AppSettings, Product } from '@/types'

/**
 * Auto-generation of product identifiers, driven by the configurable rules in
 * Settings → Product codes. This file mirrors backend/src/lib/productCodes.ts
 * (the server-side source of truth) so the product dialog can generate codes
 * offline — the same convention as the lockout policy mirror in permissions.
 *
 * SKUs are built from a format template with tokens:
 *   {PREFIX}   settings prefix (default SLV)
 *   {CATEGORY} 3-letter category code (RNG, BRC …)
 *   {SEQ}      zero-padded running sequence
 *   {SUFFIX}   settings suffix (default empty)
 * The default template `{PREFIX}-{CATEGORY}-{SEQ}` reproduces the house style
 * SLV-RNG-00001, so installs that never open the settings keep their codes.
 *
 * Barcodes are EAN-13: prefix digits (default 890 — Indian GS1) + a sequence
 * padded to 12 digits + a valid check digit, so they scan on real readers.
 */

/** The settings slice that drives code generation. */
export type ProductCodeSettings = Pick<
  AppSettings,
  'skuPrefix' | 'skuSuffix' | 'skuFormat' | 'skuSeqLength' | 'barcodePrefix'
>

export const DEFAULT_SKU_FORMAT = '{PREFIX}-{CATEGORY}-{SEQ}'

/** Category → the middle segment of auto-generated SKUs. */
const CATEGORY_PREFIX: Record<string, string> = {
  // 'Silver jewels' is the whole-catalogue default → generic code (SLV-GEN-00001)
  'Silver jewels': 'GEN',
  Rings: 'RNG',
  Chains: 'CHN',
  Bracelets: 'BRC',
  Earrings: 'ERN',
  Pendants: 'PND',
  Mangalsutra: 'MNG',
  Anklets: 'ANK',
  'Toe Rings': 'TRG',
  'Nose Pins': 'NSP',
  Necklaces: 'NCK',
  Bangles: 'BGL',
  Accessories: 'CUF',
}

export function categoryCode(category: string): string {
  const known = CATEGORY_PREFIX[category.trim()]
  if (known) return known
  const letters = category.replace(/[^a-zA-Z]/g, '').slice(0, 3).toUpperCase()
  return letters || 'GEN'
}

/** The settings slice with the shipped defaults filled in — never null. */
export interface NormalizedCodeSettings {
  skuPrefix: string
  skuSuffix: string
  skuFormat: string
  skuSeqLength: number
  barcodePrefix: string
}

/** Sanitised view of the settings with the shipped defaults filled in. */
export function normalizedCodeSettings(settings?: ProductCodeSettings | null): NormalizedCodeSettings {
  const raw = settings ?? {}
  const prefix = String(raw.skuPrefix ?? '').trim().toUpperCase() || 'SLV'
  const suffix = String(raw.skuSuffix ?? '').trim().toUpperCase() || ''
  const format = String(raw.skuFormat ?? '').trim() || DEFAULT_SKU_FORMAT
  const seqRaw = Number(raw.skuSeqLength)
  const seqLength = Number.isFinite(seqRaw) ? Math.min(8, Math.max(1, Math.round(seqRaw))) : 5
  const barcodePrefix = String(raw.barcodePrefix ?? '').replace(/\D/g, '').slice(0, 11) || '890'
  return {
    skuPrefix: prefix,
    skuSuffix: suffix,
    skuFormat: format.includes('{SEQ}') ? format : DEFAULT_SKU_FORMAT,
    skuSeqLength: seqLength,
    barcodePrefix,
  }
}

/** Render one SKU from the configured format template. */
export function renderSku(settings: ProductCodeSettings | null | undefined, category: string, seq: number): string {
  const cfg = normalizedCodeSettings(settings)
  return cfg.skuFormat
    .replaceAll('{PREFIX}', cfg.skuPrefix)
    .replaceAll('{CATEGORY}', categoryCode(category))
    .replaceAll('{SEQ}', String(Math.max(0, Math.floor(seq))).padStart(cfg.skuSeqLength, '0'))
    .replaceAll('{SUFFIX}', cfg.skuSuffix)
    .trim()
}

/**
 * Highest {SEQ} already used among SKUs matching the configured format. A
 * legacy house-style scan (PREFIX-CODE-NNNNN) runs too, so moving to a new
 * format continues the old sequence instead of restarting from 1.
 */
export function maxSequence(skus: Array<string | null | undefined>, settings?: ProductCodeSettings | null): number {
  const cfg = normalizedCodeSettings(settings)
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = cfg.skuFormat
    .split('{PREFIX}').join(escape(cfg.skuPrefix))
    .split('{CATEGORY}').join('[A-Z]{2,5}')
    .split('{SUFFIX}').join(cfg.skuSuffix ? escape(cfg.skuSuffix) : '')
    .split('{SEQ}').join('(\\d{1,8})')
  const configured = new RegExp(`^${pattern}$`, 'i')
  // Legacy fixed house style, kept so sequences survive the move to templates.
  const house = /^[A-Z]{2,5}-[A-Z]{2,5}-(\d{1,5})$/i
  let max = 0
  for (const sku of skus) {
    const value = (sku ?? '').trim().toUpperCase()
    if (!value) continue
    const m = configured.exec(value) ?? house.exec(value)
    if (!m?.[1]) continue
    const n = Number.parseInt(m[1], 10)
    if (Number.isFinite(n) && n > max) max = n
  }
  return max
}

/**
 * Next free SKU for the category under the configured format: global max
 * sequence + 1, bumped while the candidate is already taken.
 */
export function generateSku(
  existing: Array<Product | string | null>,
  category: string,
  settings?: ProductCodeSettings | null,
): string {
  const cfg = normalizedCodeSettings(settings)
  const taken = new Set(
    existing
      .map((p) => (typeof p === 'string' ? p : (p as Product).sku ?? ''))
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),
  )
  let n = maxSequence([...taken], cfg) + 1
  let sku = renderSku(cfg, category, n)
  while (taken.has(sku.toUpperCase())) {
    n += 1
    sku = renderSku(cfg, category, n)
  }
  return sku
}

/** EAN-13 check digit over the first 12 digits (weights 1/3 alternating). */
export function ean13CheckDigit(twelve: string): number {
  let sum = 0
  for (let i = 0; i < 12; i++) {
    const d = Number(twelve[i])
    sum += i % 2 === 0 ? d : d * 3
  }
  return (10 - (sum % 10)) % 10
}

/**
 * Next free EAN-13 barcode under the configured prefix: prefix digits + a
 * running sequence padded to 12 digits + a valid check digit, bumped while
 * taken. Falls back to random digits if the sequence ever outgrows the body.
 */
export function generateBarcode(
  existing: Array<Product | string | null | undefined>,
  settings?: ProductCodeSettings | null,
): string {
  const cfg = normalizedCodeSettings(settings)
  const taken = new Set(
    existing
      .map((p) => (typeof p === 'string' ? p : ((p as Product).barcode ?? '').trim()))
      .filter(Boolean),
  )
  const bodyLen = 12
  const pad = bodyLen - cfg.barcodePrefix.length
  let max = 0
  for (const code of taken) {
    if (!code.startsWith(cfg.barcodePrefix)) continue
    const digits = code.slice(0, bodyLen)
    if (!/^\d{12}$/.test(digits)) continue
    const n = Number.parseInt(digits.slice(cfg.barcodePrefix.length), 10)
    if (Number.isFinite(n) && n > max) max = n
  }
  if (max + 1 < 10 ** pad) {
    const body = cfg.barcodePrefix + String(max + 1).padStart(pad, '0')
    return body + ean13CheckDigit(body)
  }
  for (let attempt = 0; attempt < 50; attempt++) {
    const body = cfg.barcodePrefix + String(Math.floor(Math.random() * 10 ** pad)).padStart(pad, '0')
    const code = body + ean13CheckDigit(body)
    if (!taken.has(code)) return code
  }
  const body = cfg.barcodePrefix + String(Date.now() % 10 ** pad).padStart(pad, '0')
  return body + ean13CheckDigit(body)
}

/**
 * Shopify-style variant SKU: the parent SKU plus a short code per option
 * value (Small / Red → -SMA-RED). Collisions bump a numeric tail.
 */
export function generateVariantSku(parentSku: string, optionValues: string[], taken: Iterable<string>): string {
  const base = parentSku.trim().toUpperCase()
  const codes = optionValues.map((v) => v.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 3) || 'VAR')
  const candidateBase = [base, ...codes].filter(Boolean).join('-')
  const used = new Set([...taken].map((s) => (s ?? '').trim().toUpperCase()))
  let candidate = candidateBase
  let n = 2
  while (used.has(candidate)) {
    candidate = `${candidateBase}-${n}`
    n += 1
  }
  return candidate
}

export interface DuplicateMatch {
  field: 'sku' | 'barcode'
  product: Product
}

/** Existing product already using this SKU (case-insensitive) or barcode. */
export function findDuplicateProduct(
  products: Product[],
  sku: string,
  barcode: string,
  excludeId?: string,
): DuplicateMatch | null {
  const s = sku.trim().toLowerCase()
  const b = barcode.trim()
  for (const p of products) {
    if (excludeId && p.id === excludeId) continue
    if (s && (p.sku ?? '').trim().toLowerCase() === s) return { field: 'sku', product: p }
    if (b && (p.barcode ?? '').trim() === b) return { field: 'barcode', product: p }
  }
  return null
}

/**
 * Cartesian product of the option definitions, Shopify order: the LAST option
 * varies fastest (Size × Colour → Small/Red, Small/Blue, Large/Red, …).
 * Returns the joined title and the aligned per-option values.
 */
export function combineOptions(options: Array<{ name: string; values: string[] }>): Array<{ title: string; optionValues: string[] }> {
  if (options.length === 0) return []
  return options.reduce<Array<{ title: string; optionValues: string[] }>>(
    (acc, option) => {
      const values = option.values.filter((v) => v.trim() !== '')
      if (values.length === 0) return acc
      const next: Array<{ title: string; optionValues: string[] }> = []
      for (const base of acc) {
        for (const value of values) {
          next.push({ title: [...base.optionValues, value].join(' / '), optionValues: [...base.optionValues, value] })
        }
      }
      return next
    },
    [{ title: '', optionValues: [] }],
  )
}
