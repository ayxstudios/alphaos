-- Session revocation (security QA 2026-09-23, P1). A JWT session whose sign-in
-- time is older than this is refused on the next request (lib/auth/session-check.ts).
-- Set on sign-out and on an admin password reset, so a copied cookie dies with
-- the session it came from. Null = never revoked. Idempotent, like 0034-0036.
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "sessions_valid_after" timestamp with time zone;
