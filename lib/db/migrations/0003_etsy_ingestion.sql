CREATE TYPE "public"."figure_count_source" AS ENUM('shop_rule', 'heuristic', 'manual', 'unresolved');--> statement-breakpoint
ALTER TABLE "order_items" ALTER COLUMN "figure_count" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "order_items" ALTER COLUMN "figure_count" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "figure_count_source" "figure_count_source";--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "raw_variations" jsonb;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "needs_review" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "integration_config" jsonb;