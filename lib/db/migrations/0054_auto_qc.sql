-- Auto QC (Yousif 2026-10-14): an AI pass over every order waiting for QC.
-- Informational only: a row here never moves, approves or sends an order.
-- Additive and idempotent. See docs/AUTO_QC.md.
CREATE TABLE IF NOT EXISTS "auto_qc_checks" (
  "id" text PRIMARY KEY NOT NULL,
  "business_id" text NOT NULL REFERENCES "businesses"("id") ON DELETE restrict,
  "order_id" text NOT NULL REFERENCES "orders"("id") ON DELETE cascade,
  "asset_ids" jsonb NOT NULL,
  "verdict" text NOT NULL,
  "summary" text,
  "portraits" jsonb NOT NULL,
  "revision" jsonb,
  "model" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "auto_qc_checks_order_created_idx" ON "auto_qc_checks" ("order_id","created_at");--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "auto_qc_checks" TO app_user;--> statement-breakpoint
ALTER TABLE "auto_qc_checks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "auto_qc_checks_select" ON "auto_qc_checks";--> statement-breakpoint
CREATE POLICY "auto_qc_checks_select" ON "auto_qc_checks" FOR SELECT USING (app_is_staff());--> statement-breakpoint
DROP POLICY IF EXISTS "auto_qc_checks_modify" ON "auto_qc_checks";--> statement-breakpoint
CREATE POLICY "auto_qc_checks_modify" ON "auto_qc_checks" FOR ALL USING (app_is_staff()) WITH CHECK (app_is_staff());
