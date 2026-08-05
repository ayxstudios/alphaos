ALTER TYPE "public"."order_status" ADD VALUE 'awaiting_details';--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "raw_import" jsonb;