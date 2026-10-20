import type { Product } from '@/types'
import type { SyncProduct } from '@/types/shopify'

/**
 * Maps a live Shopify catalog product onto the local `Product` shape so the
 * label / print pages can render it alongside ERP rows. Shopify only ships a
 * subset of the jewellery fields, so anything missing falls back to a neutral
 * default rather than leaking `undefined` into the UI.
 */
export function shopifyProductToProduct(p: SyncProduct): Product {
  const price = Number(p.price)
  const stock = Number(p.inventoryQuantity)
  return {
    id: `shopify:${p.id}`,
    name: p.title,
    sku: p.sku,
    barcode: p.barcode ?? '',
    category: p.productType || p.collection || 'Shopify',
    collection: p.collection || '',
    purity: 0,
    grossWeight: 0,
    stoneWeight: 0,
    netWeight: 0,
    makingCharge: 0,
    gst: 0,
    hsn: '',
    supplier: '',
    silverRate: 0,
    sellingPrice: Number.isFinite(price) ? price : 0,
    compareAtPrice: p.compareAtPrice != null ? Number(p.compareAtPrice) : null,
    stock: Number.isFinite(stock) ? stock : 0,
    reorderLevel: 0,
    shopifyStatus: 'synced',
    shopifyId: String(p.id),
    status: p.status === 'active' ? 'active' : p.status === 'draft' ? 'draft' : 'inactive',
    image: p.image,
    vendor: p.vendor,
    productType: p.productType,
    chargeOnTax: p.chargeOnTax,
    createdAt: p.createdAt,
  }
}

const skuKey = (sku: string | null | undefined) => String(sku ?? '').trim().toLowerCase()

/**
 * Appends Shopify-only products to the local catalog, skipping any product
 * already present locally (matched by normalized SKU, then by Shopify id) so a
 * synced product is never duplicated.
 */
export function mergeShopifyProducts(local: Product[], shopify: SyncProduct[]): Product[] {
  const localSkus = new Set<string>()
  const localShopifyIds = new Set<string>()
  for (const p of local) {
    const key = skuKey(p.sku)
    if (key) localSkus.add(key)
    const sid = String(p.shopifyId ?? '').trim()
    if (sid) localShopifyIds.add(sid)
  }

  const merged = [...local]
  for (const sp of shopify) {
    const key = skuKey(sp.sku)
    if (key && localSkus.has(key)) continue
    if (key && merged.some((p) => skuKey(p.sku) === key)) continue
    const sid = String(sp.id)
    if (localShopifyIds.has(sid)) continue
    if (key) localSkus.add(key)
    localShopifyIds.add(sid)
    merged.push(shopifyProductToProduct(sp))
  }
  return merged
}
