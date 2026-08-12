ALTER TABLE "businesses" ADD COLUMN "daily_health_email_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "daily_health_email_recipient_ids" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "daily_health_reports" ADD COLUMN "emailed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "daily_health_reports" ADD COLUMN "email_error" text;--> statement-breakpoint
ALTER TABLE "daily_health_reports" ADD COLUMN "email_recipients" text[];