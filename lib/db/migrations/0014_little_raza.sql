ALTER TABLE "print_jobs" ADD COLUMN "tracking_company" text;--> statement-breakpoint
ALTER TABLE "print_jobs" ADD COLUMN "tracking_url" text;--> statement-breakpoint
ALTER TABLE "print_jobs" ADD COLUMN "shopify_fulfillment_id" text;--> statement-breakpoint
ALTER TABLE "print_jobs" ADD COLUMN "shopify_synced_at" timestamp with time zone;