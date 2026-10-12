-- Urgent orders (Yousif 2026-10-12): a legacy/stalled order a buyer is chasing
-- is pulled into AlphaOS as URGENT so the designer does it first. Additive only.
ALTER TABLE "orders" ADD COLUMN "urgent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "urgent_reason" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "urgent_by" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_urgent_idx" ON "orders" ("business_id") WHERE "urgent_at" IS NOT NULL;
