CREATE TABLE "email_sender_ignores" (
	"id" text PRIMARY KEY NOT NULL,
	"business_id" text NOT NULL,
	"value" text NOT NULL,
	"match_type" text DEFAULT 'email' NOT NULL,
	"note" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "suppressed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "suppressed_reason" text;--> statement-breakpoint
ALTER TABLE "email_sender_ignores" ADD CONSTRAINT "email_sender_ignores_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_sender_ignores" ADD CONSTRAINT "email_sender_ignores_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "email_sender_ignores_business_value_uq" ON "email_sender_ignores" USING btree ("business_id",lower("value"));--> statement-breakpoint
CREATE INDEX "email_sender_ignores_business_idx" ON "email_sender_ignores" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "messages_business_created_idx" ON "messages" USING btree ("business_id","created_at");--> statement-breakpoint
CREATE INDEX "messages_business_suppressed_idx" ON "messages" USING btree ("business_id","suppressed_at");--> statement-breakpoint
ALTER TABLE email_sender_ignores ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY email_sender_ignores_select ON email_sender_ignores FOR SELECT
  USING (app_is_staff());--> statement-breakpoint
CREATE POLICY email_sender_ignores_modify ON email_sender_ignores FOR ALL
  USING (app_is_staff()) WITH CHECK (app_is_staff());
