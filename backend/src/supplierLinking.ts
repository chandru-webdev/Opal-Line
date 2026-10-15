import type postgres from 'postgres'
import { logger } from './logger'

/**
 * Backfill of the `products.supplier_id` relation.
 *
 * Products carried a free-text `supplier` name long before suppliers were a
 * real table. New installs link them at save time, but an existing install has
 * years of names that never pointed at a record. This module matches those
 * names to suppliers by (case-insensitive, trimmed) name and fills the link.
 *
 * It only ever fills a link that is still null, so it is safe to run on every
 * boot and never overwrites a choice the user has since made.
 */

/** A supplier as far as matching cares: just id and name. */
export interface SupplierRef {
  id: string
  name: string
}

/** A product that still only has a free-text supplier name. */
export interface ProductSupplierName {
  id: string
  supplier: string | null
}

/** Outcome of a linking pass. */
export interface LinkResult {
  /** Number of product rows whose supplier_id was filled. */
  linked: number
  /** Distinct supplier names that match no supplier record, trimmed. */
  unmatched: string[]
}

/**
 * Normalises a supplier name for matching: trim + lower-case. This mirrors the
 * `lower(btrim(name))` comparison the SQL pass uses, so the pure matcher and
 * the database crawl agree on what counts as a match.
 */
export function normalizeSupplierName(value: unknown): string {
  return String(value ?? '').trim().toLowerCase()
}

/**
 * Finds the id of the supplier whose name matches, or null. The first match
 * wins; supplier names are unique by index, so there is normally at most one.
 */
export function findSupplierIdByName(name: unknown, suppliers: SupplierRef[]): string | null {
  const target = normalizeSupplierName(name)
  if (!target) return null
  const match = suppliers.find((s) => normalizeSupplierName(s.name) === target)
  return match ? match.id : null
}

/**
 * Pure planner used by the API to report what a linking pass would do (and by
 * the route that lists still-unmatched names). Takes the products that only
 * carry a free-text name and the full supplier list, and returns which
 * products would link and which names have no supplier.
 */
export function planProductLinks(
  products: ProductSupplierName[],
  suppliers: SupplierRef[],
): { links: { productId: string; supplierId: string }[]; unmatched: string[] } {
  const links: { productId: string; supplierId: string }[] = []
  const unmatched = new Set<string>()
  for (const product of products) {
    const name = String(product.supplier ?? '').trim()
    if (!name) continue
    const supplierId = findSupplierIdByName(name, suppliers)
    if (supplierId) links.push({ productId: product.id, supplierId })
    else unmatched.add(name)
  }
  return { links, unmatched: [...unmatched].sort((a, b) => a.localeCompare(b)) }
}

/**
 * Fills `products.supplier_id` from the free-text `supplier` name wherever a
 * supplier of that name exists, and reports the names that did not match.
 *
 * Single idempotent UPDATE: rows already linked, or with no/blank name, are
 * left untouched. Safe on a fresh, empty database.
 */
export async function linkProductsToSuppliers(sql: postgres.Sql): Promise<LinkResult> {
  const linkedRows = await sql`
    UPDATE products p
    SET supplier_id = s.id
    FROM suppliers s
    WHERE p.supplier_id IS NULL
      AND p.supplier IS NOT NULL
      AND btrim(p.supplier) <> ''
      AND lower(btrim(p.supplier)) = lower(btrim(s.name))
    RETURNING p.id
  `
  return { linked: linkedRows.length, unmatched: await unmatchedSupplierNames(sql) }
}

/**
 * Distinct, trimmed free-text supplier names on products that still have no
 * supplier record linked. Used to tell the operator which names to add.
 */
export async function unmatchedSupplierNames(sql: postgres.Sql): Promise<string[]> {
  const rows = await sql`
    SELECT DISTINCT btrim(p.supplier) AS name
    FROM products p
    WHERE p.supplier IS NOT NULL
      AND btrim(p.supplier) <> ''
      AND p.supplier_id IS NULL
    ORDER BY name
  `
  return rows.map((row) => String(row.name))
}

/**
 * Best-effort linking at boot. Never throws: a failure here must not stop the
 * server, so it is logged and swallowed.
 */
export async function linkProductsToSuppliersSafe(sql: postgres.Sql): Promise<LinkResult | null> {
  try {
    const result = await linkProductsToSuppliers(sql)
    if (result.linked > 0 || result.unmatched.length > 0) {
      logger.info(
        { linked: result.linked, unmatched: result.unmatched.length },
        'Bootstrap: linked products to supplier records',
      )
    }
    return result
  } catch (err) {
    logger.warn({ err }, 'Bootstrap: supplier linking skipped')
    return null
  }
}
