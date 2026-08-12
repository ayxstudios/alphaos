ALTER TABLE "orders" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "archive_reason" text;--> statement-breakpoint
CREATE INDEX "orders_live_board_idx" ON "orders" USING btree ("business_id","status","due_at") WHERE "orders"."archived_at" is null;