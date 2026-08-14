CREATE TYPE "public"."job_run_status" AS ENUM('running', 'ok', 'failed', 'partial');--> statement-breakpoint
CREATE TABLE "job_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"job_name" text NOT NULL,
	"business_id" text,
	"shop_id" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" "job_run_status" DEFAULT 'running' NOT NULL,
	"items_processed" integer DEFAULT 0 NOT NULL,
	"items_failed" integer DEFAULT 0 NOT NULL,
	"error" text,
	"metadata" jsonb
);
--> statement-breakpoint
ALTER TABLE "job_runs" ADD CONSTRAINT "job_runs_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_runs" ADD CONSTRAINT "job_runs_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_runs_lookup_idx" ON "job_runs" USING btree ("job_name","business_id","shop_id","started_at");--> statement-breakpoint
CREATE INDEX "job_runs_started_idx" ON "job_runs" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "job_runs_status_idx" ON "job_runs" USING btree ("status","started_at");--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "job_runs" TO app_user;--> statement-breakpoint
ALTER TABLE "job_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY job_runs_select ON job_runs FOR SELECT
  USING (app_is_admin());--> statement-breakpoint
CREATE POLICY job_runs_insert ON job_runs FOR INSERT
  WITH CHECK (app_is_admin());--> statement-breakpoint
CREATE POLICY job_runs_update ON job_runs FOR UPDATE
  USING (app_is_admin()) WITH CHECK (app_is_admin());--> statement-breakpoint
CREATE POLICY job_runs_delete ON job_runs FOR DELETE
  USING (app_is_admin());
