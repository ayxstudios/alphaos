-- Security QA round 2 (docs/QA-2026-09-23-security-r2.md, round 1 P2): two
-- designer policies granted more than any app path uses.
--   messages_select: an assigned designer could read the customer email thread
--     (address, body). The order page already drops those rows for designers;
--     no designer path reads messages. Now staff only.
--   designer_profiles_modify: a designer could rewrite their own rate, rank and
--     capacity. Every writer is a staff action (designers, styles); /me reads.
--     Now staff only. designer_profiles_select is unchanged (own row readable).
-- Policies only, no data touched. Idempotent. Takes a brief lock on each table.
DROP POLICY IF EXISTS "messages_select" ON "messages";--> statement-breakpoint
CREATE POLICY "messages_select" ON "messages" FOR SELECT
  USING (app_is_staff());--> statement-breakpoint
DROP POLICY IF EXISTS "designer_profiles_modify" ON "designer_profiles";--> statement-breakpoint
CREATE POLICY "designer_profiles_modify" ON "designer_profiles" FOR ALL
  USING (app_is_staff())
  WITH CHECK (app_is_staff());
