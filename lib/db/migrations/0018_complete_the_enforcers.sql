ALTER TABLE "businesses" ADD COLUMN "gmail_last_polled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "archived_at" timestamp with time zone;