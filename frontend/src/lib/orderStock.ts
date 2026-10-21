/**
 * Client-side stock shortfall helpers for the Manual Order modal.
 *
 * The server remains the authority — it re-checks stock inside the order
 * transaction at the chosen location. These helpers only mirror that check
 * against the already-loaded product catalog so an over-quantity is flagged
 * under the Qty field while the user types, and translate the server's own
 * "Insufficient stock for SKU …" response back onto the offending line.
 */

export interface StockValidationLine {
  key: string
  productId: string
  sku: string
  qty: number
  /**
   * Variant selected on this line, when the product has variants. Lines of
   * different variants are stocked and validated independently.
   */
  variantId?: string | null
  /**
   * Stock available for exactly this line's SKU/variant. When present it wins
   * over the product-level `stockByProductId` lookup (variant lines carry
   * their own stock); absent means "use the product's stock".
   */
  stock?: number | null
}

export function formatStockShortfall(available: number, requested: number): string {
  return `Only ${available} units available. You entered ${requested}.`
}

function normalizeQty(qty: number): number {
  return Math.max(0, Math.floor(Number(qty) || 0))
}

/**
 * Per-line shortfall errors, keyed by line key. Lines are processed in order
 * and each one's availability is reduced by earlier lines of the same
 * product/variant, matching how the server deducts stock line by line inside
 * its transaction. Lines whose stock is entirely unknown (no per-line figure
 * and no product row) are skipped.
 */
export function computeLineStockErrors(
  lines: StockValidationLine[],
  stockByProductId: ReadonlyMap<string, number>,
): Record<string, string> {
  const errors: Record<string, string> = {}
  const committed = new Map<string, number>()
  for (const li of lines) {
    if (!li.productId && !li.variantId) continue
    const stock = typeof li.stock === 'number' ? li.stock : stockByProductId.get(li.productId)
    if (stock == null) continue
    const qty = normalizeQty(li.qty)
    // Variants stock independently of each other and of the parent product.
    const bucket = li.variantId ? `${li.productId}::${li.variantId}` : li.productId
    const already = committed.get(bucket) ?? 0
    const available = stock - already
    if (qty > available) {
      errors[li.key] = formatStockShortfall(available, qty)
    }
    committed.set(bucket, already + qty)
  }
  return errors
}

const INSUFFICIENT_STOCK_RE =
  /^Insufficient stock for SKU (.+?) at this location: available (\d+), requested (\d+)$/

/** Parses the order create/update endpoint's stock error, if that is what failed. */
export function parseInsufficientStockError(
  message: string,
): { sku: string; available: number; requested: number } | null {
  const m = INSUFFICIENT_STOCK_RE.exec(message.trim())
  if (!m) return null
  return { sku: m[1].trim(), available: Number(m[2]), requested: Number(m[3]) }
}

/**
 * Maps a rejected create/update response onto the line item that caused it,
 * reusing the server's validation result instead of re-deriving it. Returns
 * an empty object when the failure was not a stock shortfall.
 */
export function stockErrorsFromApiError(
  err: unknown,
  lines: StockValidationLine[],
): Record<string, string> {
  const parsed = parseInsufficientStockError(err instanceof Error ? err.message : '')
  if (!parsed) return {}
  const sku = parsed.sku.toLowerCase()
  const matches = lines.filter((li) => li.sku.trim().toLowerCase() === sku)
  if (matches.length === 0) return {}
  const target = matches.find((li) => normalizeQty(li.qty) === parsed.requested) ?? matches[0]
  return { [target.key]: formatStockShortfall(parsed.available, parsed.requested) }
}
