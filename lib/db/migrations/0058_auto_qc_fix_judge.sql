-- Auto QC judges the AI fix too (Yousif 2026-10-14: "The AutoQC should even
-- judge the AI fix too"). A ready fix gets its own Auto QC pass (same checks
-- as the designer's version); /approve shows the verdict on the AI fix panel
-- so the owner knows the fix was checked before leaning on it. Additive and
-- idempotent. See docs/AUTO_QC.md "Fix samples".
ALTER TABLE "auto_qc_fixes" ADD COLUMN IF NOT EXISTS "qc_verdict" text;--> statement-breakpoint
ALTER TABLE "auto_qc_fixes" ADD COLUMN IF NOT EXISTS "qc_summary" text;--> statement-breakpoint
ALTER TABLE "auto_qc_fixes" ADD COLUMN IF NOT EXISTS "qc_checks" jsonb NOT NULL DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "auto_qc_fixes" ADD COLUMN IF NOT EXISTS "qc_model" text;--> statement-breakpoint
ALTER TABLE "auto_qc_fixes" ADD COLUMN IF NOT EXISTS "qc_at" timestamp with time zone;
