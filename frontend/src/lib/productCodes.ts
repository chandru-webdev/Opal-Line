import type { Product } from '@/types'

/**
 * Auto-generation of product identifiers.
 *
 * SKUs follow the house style already used across the catalogue
 * (`SLV-RNG-00001` — house prefix, category code, 5-digit sequence).
 * Barcodes are EAN-13 with the Indian GS1 prefix 890 and a valid check digit,
 * so they scan on real barcode readers.
 */

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

function categoryCode(category: string): string {
  const known = CATEGORY_PREFIX[category.trim()]
  if (known) return known
  const letters = category.replace(/[^a-zA-Z]/g, '').slice(0, 3).toUpperCase()
  return letters || 'GEN'
}

/** House-style SKU: PREFIX-CODE-SEQUENCE, e.g. SLV-RNG-00021. */
const HOUSE_SKU = /^[A-Z]{2,5}-[A-Z]{2,5}-(\d{1,5})$/

/**
 * Highest sequence used by a house-style SKU (SLV-RNG-00021 → 21). Barcodes
 * or ids used as SKUs are ignored so a stray 13-digit "SKU" can never turn
 * the next generated code into SLV-GEN-9407839469820.
 */
export function maxSequence(skus: Array<string | null | undefined>): number {
  let max = 0
  for (const sku of skus) {
    const m = HOUSE_SKU.exec((sku ?? '').trim().toUpperCase())
    if (m) {
      const n = Number.parseInt(m[1], 10)
      if (Number.isFinite(n) && n > max) max = n
    }
  }
  return max
}

/**
 * Next free SKU for the category: global max sequence + 1, bumped while the
 * candidate is already taken, so the result never collides with `existing`.
 */
export function generateSku(existing: Array<Product | string | null>, category: string): string {
  const taken = new Set(
    existing
      .map((p) => (typeof p === 'string' ? p : (p as Product).sku ?? ''))
      .map((s) => s.trim().toUpperCase()),
  )
  let n = maxSequence([...taken]) + 1
  let sku = `SLV-${categoryCode(category)}-${String(n).padStart(5, '0')}`
  while (taken.has(sku.toUpperCase())) {
    n += 1
    sku = `SLV-${categoryCode(category)}-${String(n).padStart(5, '0')}`
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
 * Next free EAN-13 barcode: 890 (Indian GS1 prefix) + 9 random digits + a
 * valid check digit, retried until it is not already used in `existing`.
 */
export function generateBarcode(existing: Array<Product | string | null | undefined>): string {
  const taken = new Set(
    existing
      .map((p) => (typeof p === 'string' ? p : ((p as Product).barcode ?? '').trim()))
      .filter(Boolean),
  )
  for (let attempt = 0; attempt < 50; attempt++) {
    const body = '890' + String(Math.floor(Math.random() * 1_000_000_000)).padStart(9, '0')
    const code = body + ean13CheckDigit(body)
    if (!taken.has(code)) return code
  }
  // 9 random digits ⇒ collision odds are negligible; last-resort timestamp fallback.
  const body = '890' + String(Date.now() % 1_000_000_000).padStart(9, '0')
  return body + ean13CheckDigit(body)
}

export interface DuplicateMatch {
  field: 'sku' | 'barcode'
  product: Product
}

/**
 * Existing product already using this SKU (case-insensitive) or barcode.
 * `excludeId` skips the product being edited.
 */
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
