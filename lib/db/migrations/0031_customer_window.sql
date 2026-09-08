ALTER TYPE "public"."channel_type" ADD VALUE 'etsy';--> statement-breakpoint
ALTER TYPE "public"."email_template_key" ADD VALUE 'order_received';--> statement-breakpoint
ALTER TYPE "public"."email_template_key" ADD VALUE 'in_design';--> statement-breakpoint
ALTER TYPE "public"."email_template_key" ADD VALUE 'printing';--> statement-breakpoint
ALTER TYPE "public"."email_template_key" ADD VALUE 'shipped';--> statement-breakpoint
ALTER TYPE "public"."email_template_key" ADD VALUE 'photo_reminder';--> statement-breakpoint
ALTER TYPE "public"."email_template_key" ADD VALUE 'proof_reminder';--> statement-breakpoint
CREATE TABLE "reminder_fires" (
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
ALTER TABLE "businesses" ADD COLUMN "stage_email_auto_send" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "reminder_fires" ADD CONSTRAINT "reminder_fires_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminder_fires" ADD CONSTRAINT "reminder_fires_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reminder_fires_business_kind_idx" ON "reminder_fires" USING btree ("business_id","kind","fired_at");--> statement-breakpoint
ALTER TABLE "reminder_fires" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "reminder_fires_select" ON "reminder_fires" FOR SELECT
  USING (app_is_staff());--> statement-breakpoint
CREATE POLICY "reminder_fires_modify" ON "reminder_fires" FOR ALL
  USING (app_is_staff()) WITH CHECK (app_is_staff());
