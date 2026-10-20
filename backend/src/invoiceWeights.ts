import { sql } from 'drizzle-orm'
import { db } from './db/client'

/**
 * Weight snapshot backfill for invoice items.
 *
 * Invoices raised before the weight snapshot existed carry weight 0 on every
 * line ("0.00 gm" in prints and dashboards). When the product catalogue knows
 * a SKU's net weight, the item's real weight is net weight × qty — the same
 * snapshot createInvoiceForOrderRow now writes on new invoices.
 *
 * Idempotent and safe to run on every boot:
 *   - only items whose weight is still 0/NULL are touched,
 *   - only when the catalogue has a net weight (> 0) for that SKU,
 *   - items whose weight is genuinely unknown stay 0 and render as "—".
 *
 * Returns the number of items updated.
 */
export async function backfillInvoiceItemWeights(client?: { execute: (q: ReturnType<typeof sql>) => PromiseLike<unknown[]> } | null): Promise<number> {
  const conn = client ?? (db as unknown as { execute: (q: ReturnType<typeof sql>) => PromiseLike<unknown[]> } | null)
  if (!conn) return 0
  const updated = await conn.execute(sql`
    UPDATE sales_invoice_items it
    SET weight = ROUND(p.net_weight * it.qty, 3)
    FROM products p
    WHERE it.sku = p.sku
      AND p.net_weight > 0
      AND it.qty IS NOT NULL
      AND (it.weight IS NULL OR it.weight = 0)
    RETURNING it.id
  `)
  return updated.length
}
