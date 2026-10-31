-- Every pet has its photo before anyone draws (Yousif 2026-10-31, Delaney
-- 4200623137 plan phase 1). One json per order, written by the agent's photo
-- check: a named slot for each pet or person bought, how clear its face is,
-- which of her photos shows whom, and any staff "photo is fine" clears. The
-- shape is lib/photos/subject-types.ts. Null = never checked (no gate).
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "photo_subjects" jsonb;--> statement-breakpoint
-- The one photo ask, naming the pet whose face is missing. Idempotent like 0042.
ALTER TYPE "public"."email_template_key" ADD VALUE IF NOT EXISTS 'photo_subject_ask';
