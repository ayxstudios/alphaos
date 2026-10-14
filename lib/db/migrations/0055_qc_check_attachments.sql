-- Failed QC can carry pictures (Yousif 2026-10-14): a reviewer attaches a
-- marked-up screenshot or reference when sending an order back, and the
-- designer sees it. Additive and idempotent.
-- The pictures are assets of a new kind; the list on the fail is a jsonb array
-- of {assetId, key, filename}. RLS: assets_select / qc_checks_select already
-- follow the order (staff, the assigned designer, helpers); only staff insert
-- a qc_feedback asset (assets_designer_insert only allows type 'submission').
ALTER TYPE "public"."asset_type" ADD VALUE IF NOT EXISTS 'qc_feedback';--> statement-breakpoint
ALTER TABLE "qc_checks" ADD COLUMN IF NOT EXISTS "attachments" jsonb;
