-- Two portraits in one email (W1, data layer). Add-only and backward
-- compatible: every new column is nullable or defaulted, so code from before
-- this migration keeps working while a deploy rolls out. Idempotent. Numbered
-- 0059 (0057 auto_qc_fixes and 0058 auto_qc_fix_judge landed first).
--
--   order_items.quantity  how many portraits this line is for (the Etsy/Shopify
--                         quantity; 1 for every line that existed before)
--   assets.portrait_unit  which unit of a quantity>1 line an upload is for;
--                         NULL = unit 1; only meaningful with order_item_id
--   proofs.files          the ordered files a sent proof/QC email shows,
--                         [{ "assetId": "...", "label": "..." }]; written by a
--                         later step (nothing reads it yet)
-- No new table, so no new grants or policies: app_user already has table-level
-- access to all three and there are no column-level grants to mirror.
ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "quantity" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "order_items" ADD CONSTRAINT "order_items_quantity_ck" CHECK ("quantity" >= 1);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN IF NOT EXISTS "portrait_unit" smallint;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "assets" ADD CONSTRAINT "assets_portrait_unit_ck" CHECK ("portrait_unit" IS NULL OR "portrait_unit" >= 1);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
ALTER TABLE "proofs" ADD COLUMN IF NOT EXISTS "files" jsonb;
