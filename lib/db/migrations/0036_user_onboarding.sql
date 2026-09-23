-- First-run tour progress per user (lib/tour/state.ts). Nullable: null means the
-- person has never seen the tour. Idempotent, like 0034/0035. The "user" table has
-- no RLS (Auth.js table); request paths still write it through withUserContext.
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "onboarding" jsonb;
