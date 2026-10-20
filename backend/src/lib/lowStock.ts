import { sql } from 'drizzle-orm'
import { products } from '../db/schema'

/**
 * Products without a per-product reorder level fall back to this threshold so
 * they still flag for restocking (seed products use 4–15; 10 sits mid-range,
 * and the Shopify/product import writes no reorder level at all). Every
 * low-stock consumer must apply the same rule: the KPI count, the dashboard
 * table, the inventory overview, the notification bell and the alert email.
 */
export const DEFAULT_REORDER_LEVEL = 10

/** Trackable, stocked products at or below their effective reorder level. */
export const lowStockWhere = () =>
  sql`coalesce(${products.trackInventory}, true) <> false and ${products.stock} is not null and ${products.stock} <= coalesce(${products.reorderLevel}, ${DEFAULT_REORDER_LEVEL})`
