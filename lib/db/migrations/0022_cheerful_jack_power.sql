CREATE TABLE "notification_fires" (
	"id" text PRIMARY KEY NOT NULL,
	"business_id" text NOT NULL,
	"alert_type" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"metadata" jsonb,
	"triggered_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_fires_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "fire_id" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "body" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "href" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "metadata" jsonb;--> statement-breakpoint
ALTER TABLE "notification_fires" ADD CONSTRAINT "notification_fires_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notification_fires_business_type_idx" ON "notification_fires" USING btree ("business_id","alert_type","triggered_at");--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_fire_id_notification_fires_id_fk" FOREIGN KEY ("fire_id") REFERENCES "public"."notification_fires"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_fires" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "notification_fires_select" ON "notification_fires" FOR SELECT
  USING (app_is_staff());--> statement-breakpoint
CREATE POLICY "notification_fires_modify" ON "notification_fires" FOR ALL
  USING (app_is_staff()) WITH CHECK (app_is_staff());
