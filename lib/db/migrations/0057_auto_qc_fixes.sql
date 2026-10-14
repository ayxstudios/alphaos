-- Auto QC fix samples (Yousif 2026-10-14): for an order whose Auto QC found
-- problems, the AI repaints ONLY those spots on the designer's portrait and
-- offers the result on /approve as a suggestion. Nothing here sends or moves
-- an order: the owner's "Send AI fix" tap turns a ready row into a new artwork
-- version (used_asset_id) and approves it. Additive and idempotent.
-- See docs/AUTO_QC.md "Fix samples".
CREATE TABLE IF NOT EXISTS "auto_qc_fixes" (
  "id" text PRIMARY KEY NOT NULL,
  "business_id" text NOT NULL REFERENCES "businesses"("id") ON DELETE restrict,
  "order_id" text NOT NULL REFERENCES "orders"("id") ON DELETE cascade,
  "auto_qc_id" text REFERENCES "auto_qc_checks"("id") ON DELETE set null,
  "source_asset_id" text NOT NULL REFERENCES "assets"("id") ON DELETE cascade,
  "portrait" integer,
  "status" text NOT NULL,
  "r2_key" text,
  "content_type" text,
  "width" integer,
  "height" integer,
  "fixed" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "not_fixed" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "summary" text,
  "model" text,
  "engine" text,
  "used_asset_id" text REFERENCES "assets"("id") ON DELETE set null,
  "decided_by" text REFERENCES "user"("id") ON DELETE set null,
  "decided_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "auto_qc_fixes_order_created_idx" ON "auto_qc_fixes" ("order_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "auto_qc_fixes_used_asset_idx" ON "auto_qc_fixes" ("used_asset_id");--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "auto_qc_fixes" TO app_user;--> statement-breakpoint
ALTER TABLE "auto_qc_fixes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "auto_qc_fixes_select" ON "auto_qc_fixes";--> statement-breakpoint
CREATE POLICY "auto_qc_fixes_select" ON "auto_qc_fixes" FOR SELECT USING (app_is_staff());--> statement-breakpoint
DROP POLICY IF EXISTS "auto_qc_fixes_modify" ON "auto_qc_fixes";--> statement-breakpoint
CREATE POLICY "auto_qc_fixes_modify" ON "auto_qc_fixes" FOR ALL USING (app_is_staff()) WITH CHECK (app_is_staff());
