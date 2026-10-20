-- Purchase order detail page: GST breakdown (3% default), discount, grand
-- total, notes and expected delivery date. Existing rows are backfilled so
-- old POs display the same way new ones do.
ALTER TABLE "purchase_orders" ADD COLUMN IF NOT EXISTS "gst" numeric DEFAULT 3;
ALTER TABLE "purchase_orders" ADD COLUMN IF NOT EXISTS "gst_amount" numeric;
ALTER TABLE "purchase_orders" ADD COLUMN IF NOT EXISTS "discount" numeric DEFAULT 0;
ALTER TABLE "purchase_orders" ADD COLUMN IF NOT EXISTS "grand_total" numeric;
ALTER TABLE "purchase_orders" ADD COLUMN IF NOT EXISTS "notes" text;
ALTER TABLE "purchase_orders" ADD COLUMN IF NOT EXISTS "expected_date" timestamp;
UPDATE "purchase_orders" SET "gst" = 3 WHERE "gst" IS NULL;
UPDATE "purchase_orders" SET "gst_amount" = round(coalesce("value", 0) * 0.03, 2) WHERE "gst_amount" IS NULL;
UPDATE "purchase_orders" SET "discount" = 0 WHERE "discount" IS NULL;
UPDATE "purchase_orders" SET "grand_total" = round(coalesce("value", 0) + coalesce("gst_amount", 0) - coalesce("discount", 0), 2) WHERE "grand_total" IS NULL;
