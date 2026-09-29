-- Legacy / Trello intake + unindexed products. Idempotent.
-- orders.source gains 'legacy' (stub for an order that lives outside AlphaOS,
-- opened when a buyer email matches nothing) and 'trello' (bulk-imported card).
ALTER TYPE "order_source" ADD VALUE IF NOT EXISTS 'legacy';
--> statement-breakpoint
ALTER TYPE "order_source" ADD VALUE IF NOT EXISTS 'trello';
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "trello_card_id" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "orders_trello_card_uq" ON "orders" ("business_id", "trello_card_id") WHERE "trello_card_id" IS NOT NULL;
--> statement-breakpoint
-- A catalog row the agent created for a product it had never seen: no designer
-- yet, AI designer off. Cleared when someone picks who draws it.
ALTER TABLE "styles" ADD COLUMN IF NOT EXISTS "auto_created" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "styles" ADD COLUMN IF NOT EXISTS "listing_title" text;
