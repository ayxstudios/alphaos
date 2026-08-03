ALTER TABLE "order_items" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "options" jsonb;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "platform_order_name" text;