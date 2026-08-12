CREATE TABLE "daily_health_reports" (
	"id" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"scope_id" text NOT NULL,
	"business_id" text,
	"report_date" text NOT NULL,
	"metrics_hash" text NOT NULL,
	"narrative" text NOT NULL,
	"status" text DEFAULT 'ok' NOT NULL,
	"error" text,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "daily_health_reports" ADD CONSTRAINT "daily_health_reports_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "daily_health_reports_scope_date_uq" ON "daily_health_reports" USING btree ("scope","scope_id","report_date");--> statement-breakpoint
CREATE INDEX "daily_health_reports_lookup_idx" ON "daily_health_reports" USING btree ("scope","scope_id","report_date");--> statement-breakpoint
CREATE INDEX "activity_log_business_action_created_idx" ON "activity_log" USING btree ("business_id","action","created_at");--> statement-breakpoint
CREATE INDEX "earnings_business_status_created_idx" ON "earnings" USING btree ("business_id","status","created_at");--> statement-breakpoint
CREATE INDEX "messages_business_status_created_idx" ON "messages" USING btree ("business_id","status","created_at");--> statement-breakpoint
CREATE INDEX "qc_checks_business_created_idx" ON "qc_checks" USING btree ("business_id","created_at");--> statement-breakpoint
ALTER TABLE "daily_health_reports" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "daily_health_reports_select" ON "daily_health_reports" FOR SELECT
  USING (app_is_staff());--> statement-breakpoint
CREATE POLICY "daily_health_reports_modify" ON "daily_health_reports" FOR ALL
  USING (app_is_staff()) WITH CHECK (app_is_staff());
