CREATE TABLE "print_reconcile_ledger" (
	"id" text PRIMARY KEY NOT NULL,
	"business_id" text NOT NULL,
	"order_id" text,
	"print_job_id" text,
	"provider" text NOT NULL,
	"event_key" text NOT NULL,
	"outcome" text NOT NULL,
	"source" text NOT NULL,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "print_credentials" jsonb;--> statement-breakpoint
ALTER TABLE "print_jobs" ADD COLUMN "provider_status" text;--> statement-breakpoint
ALTER TABLE "print_jobs" ADD COLUMN "provider_status_reason" text;--> statement-breakpoint
ALTER TABLE "print_jobs" ADD COLUMN "provider_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "print_jobs" ADD COLUMN "provider_matched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "print_jobs" ADD COLUMN "reconcile_state" text DEFAULT 'unchecked' NOT NULL;--> statement-breakpoint
ALTER TABLE "print_jobs" ADD COLUMN "reconcile_note" text;--> statement-breakpoint
ALTER TABLE "print_jobs" ADD COLUMN "missing_flagged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "print_reconcile_ledger" ADD CONSTRAINT "print_reconcile_ledger_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "print_reconcile_ledger" ADD CONSTRAINT "print_reconcile_ledger_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "print_reconcile_ledger" ADD CONSTRAINT "print_reconcile_ledger_print_job_id_print_jobs_id_fk" FOREIGN KEY ("print_job_id") REFERENCES "public"."print_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "print_reconcile_ledger_event_key_uq" ON "print_reconcile_ledger" USING btree ("event_key");--> statement-breakpoint
CREATE INDEX "print_reconcile_ledger_job_idx" ON "print_reconcile_ledger" USING btree ("print_job_id","created_at");--> statement-breakpoint
CREATE INDEX "print_jobs_reconcile_idx" ON "print_jobs" USING btree ("business_id","reconcile_state");--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "print_reconcile_ledger" TO app_user;--> statement-breakpoint
ALTER TABLE "print_reconcile_ledger" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY print_reconcile_ledger_select ON "print_reconcile_ledger" FOR SELECT USING (app_is_staff());--> statement-breakpoint
CREATE POLICY print_reconcile_ledger_insert ON "print_reconcile_ledger" FOR INSERT WITH CHECK (app_is_staff());
