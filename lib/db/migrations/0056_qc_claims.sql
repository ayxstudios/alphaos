-- Two owners on /approve (Yousif 2026-10-14: "me and him can't really overlap
-- in our work or if we do it chooses the one that was first"). The order on a
-- person's Approve screen is claimed by them: the other owner's queue skips it
-- and a pass or fail from anyone else is refused while the claim is fresh
-- (seen_at within lib/qc/claims.ts CLAIM_TTL_MS). One row per order, reused
-- for every round. Additive and idempotent. RLS: staff only, like auto_qc_checks.
CREATE TABLE IF NOT EXISTS "qc_claims" (
  "order_id" text PRIMARY KEY NOT NULL REFERENCES "orders"("id") ON DELETE cascade,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE cascade,
  "claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "seen_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "qc_claims_seen_idx" ON "qc_claims" ("seen_at");--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "qc_claims" TO app_user;--> statement-breakpoint
ALTER TABLE "qc_claims" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "qc_claims_select" ON "qc_claims";--> statement-breakpoint
CREATE POLICY "qc_claims_select" ON "qc_claims" FOR SELECT USING (app_is_staff());--> statement-breakpoint
DROP POLICY IF EXISTS "qc_claims_modify" ON "qc_claims";--> statement-breakpoint
CREATE POLICY "qc_claims_modify" ON "qc_claims" FOR ALL USING (app_is_staff()) WITH CHECK (app_is_staff());
