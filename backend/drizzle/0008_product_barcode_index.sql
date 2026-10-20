-- Product barcode indexes.
--
-- NOT APPLIED by this change. The application enforces barcode uniqueness in a
-- transaction-scoped advisory lock (see createProductHandler / updateProductHandler
-- / the /products/:id/barcode and /products/barcodes/generate routes in
-- backend/src/routes/db.ts), so no schema change is required for correctness.
-- This migration adds the database-level guarantees and the index the scanner
-- lookup wants.
--
-- COMPATIBILITY / PREREQUISITE
--   The partial UNIQUE index fails if two products already share the same
--   non-empty barcode. Check first:
--
--     SELECT barcode, count(*) FROM products
--     WHERE barcode IS NOT NULL AND barcode <> ''
--     GROUP BY barcode HAVING count(*) > 1;
--
--   Resolve any rows returned above (re-assign the wrong one via the product
--   barcode action) before applying this migration.

-- Fast exact-match lookup for the scanner (/db/products/scan).
CREATE INDEX IF NOT EXISTS "products_barcode_idx"
  ON "products" ("barcode")
  WHERE "barcode" IS NOT NULL AND "barcode" <> '';

-- One barcode identifies exactly one product. Partial so any number of products
-- may legitimately have no barcode.
CREATE UNIQUE INDEX IF NOT EXISTS "products_barcode_unique_idx"
  ON "products" ("barcode")
  WHERE "barcode" IS NOT NULL AND "barcode" <> '';
