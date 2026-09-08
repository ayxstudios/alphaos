-- Consolidation after three parallel lanes each generated 0031. Every statement is
-- idempotent because the shared database already carries all of them.
ALTER TYPE "public"."channel_type" ADD VALUE IF NOT EXISTS 'etsy';--> statement-breakpoint
ALTER TYPE "public"."email_template_key" ADD VALUE IF NOT EXISTS 'order_received';--> statement-breakpoint
ALTER TYPE "public"."email_template_key" ADD VALUE IF NOT EXISTS 'in_design';--> statement-breakpoint
ALTER TYPE "public"."email_template_key" ADD VALUE IF NOT EXISTS 'printing';--> statement-breakpoint
ALTER TYPE "public"."email_template_key" ADD VALUE IF NOT EXISTS 'shipped';--> statement-breakpoint
ALTER TYPE "public"."email_template_key" ADD VALUE IF NOT EXISTS 'photo_reminder';--> statement-breakpoint
ALTER TYPE "public"."email_template_key" ADD VALUE IF NOT EXISTS 'proof_reminder';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reminder_fires" (
	"id" text PRIMARY KEY NOT NULL,
	"business_id" text NOT NULL,
	"order_id" text,
	"kind" text NOT NULL,
	"subject_id" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"metadata" jsonb,
	"fired_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reminder_fires_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN IF NOT EXISTS "stage_email_auto_send" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "designer_profiles" ADD COLUMN IF NOT EXISTS "phone" text;--> statement-breakpoint
ALTER TABLE "designer_profiles" ADD COLUMN IF NOT EXISTS "preferred_channel" text DEFAULT 'whatsapp' NOT NULL;--> statement-breakpoint
ALTER TABLE "designer_profiles" ADD COLUMN IF NOT EXISTS "timezone" text;--> statement-breakpoint
ALTER TABLE "designer_profiles" ADD COLUMN IF NOT EXISTS "quiet_start" text;--> statement-breakpoint
ALTER TABLE "designer_profiles" ADD COLUMN IF NOT EXISTS "quiet_end" text;--> statement-breakpoint
ALTER TABLE "designer_profiles" ADD COLUMN IF NOT EXISTS "max_active_orders" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
DO $$ BEGIN
ALTER TABLE "reminder_fires" ADD CONSTRAINT "reminder_fires_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
ALTER TABLE "reminder_fires" ADD CONSTRAINT "reminder_fires_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reminder_fires_business_kind_idx" ON "reminder_fires" USING btree ("business_id","kind","fired_at");