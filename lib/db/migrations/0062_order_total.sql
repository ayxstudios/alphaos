-- Order value for routing (Yousif 2026-10-16: Mar takes no new orders unless
-- they are over AUD 300, the PixArt BOGO offer). Add-only and backward
-- compatible: both columns are nullable, so code from before this migration
-- keeps working while a deploy rolls out. Idempotent.
--
--   orders.order_total     the grand total in the shop's currency at import
--                          (Shopify totalPriceSet.shopMoney, Etsy receipt
--                          grandtotal); NULL = unknown (manual, Trello, legacy)
--   orders.order_currency  ISO code of that total ("AUD")
-- Etsy rows are filled from the receipt already stored in raw_import; open
-- Shopify orders are filled by the agent from the Admin API.
-- No new table, so no new grants or policies.
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "order_total" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "order_currency" text;--> statement-breakpoint
UPDATE "orders"
SET "order_total" = round(("raw_import"->'grandtotal'->>'amount')::numeric / ("raw_import"->'grandtotal'->>'divisor')::numeric, 2),
    "order_currency" = upper("raw_import"->'grandtotal'->>'currency_code')
WHERE "source" = 'etsy'
  AND "order_total" IS NULL
  AND jsonb_typeof("raw_import"->'grandtotal') = 'object'
  AND ("raw_import"->'grandtotal'->>'amount') ~ '^-?[0-9]+(\.[0-9]+)?$'
  AND ("raw_import"->'grandtotal'->>'divisor') ~ '^[1-9][0-9]*$';
