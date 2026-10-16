-- Wrong-file stop (incident 16 Oct 2026: PixArt PC32132, Saiya alone portrait,
-- was proofed with the PC32131 Parker+Saiya landscape file). Add-only and
-- backward compatible: every column is nullable, so code from before this
-- migration keeps working while a deploy rolls out. Idempotent.
--
--   assets.dhash         64-bit difference hash of the image as 16 hex chars;
--                        NULL = not an image we could decode (PDF, HEIC) or
--                        not hashed yet (scripts/backfill-asset-hashes.ts)
--   assets.width/height  pixel size after EXIF rotation, for the orientation warning
--   auto_qc_checks.wrong_file  {kind, note} when the Auto QC judge says the
--                        file is not this order's artwork; shuts Approve
-- No new table, so no new grants or policies.
ALTER TABLE "assets" ADD COLUMN IF NOT EXISTS "dhash" text;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN IF NOT EXISTS "width" integer;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN IF NOT EXISTS "height" integer;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "assets_dhash_idx" ON "assets" ("business_id", "created_at") WHERE "dhash" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "auto_qc_checks" ADD COLUMN IF NOT EXISTS "wrong_file" jsonb;
