ALTER TABLE "designer_profiles" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "designer_profiles" ADD COLUMN "preferred_channel" text DEFAULT 'whatsapp' NOT NULL;--> statement-breakpoint
ALTER TABLE "designer_profiles" ADD COLUMN "timezone" text;--> statement-breakpoint
ALTER TABLE "designer_profiles" ADD COLUMN "quiet_start" text;--> statement-breakpoint
ALTER TABLE "designer_profiles" ADD COLUMN "quiet_end" text;--> statement-breakpoint
ALTER TABLE "designer_profiles" ADD COLUMN "max_active_orders" integer DEFAULT 0 NOT NULL;