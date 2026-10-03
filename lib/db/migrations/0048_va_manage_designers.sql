-- VAs manage designers (Yousif 2026-10-01): a VA can add a designer, remove
-- (deactivate) one, and make their sign-in link, from the Designers page. The
-- app gates live in lib/team/manage.ts / app/(app)/designers/actions.ts; these
-- policies are the real boundary. A VA still cannot create, edit or deactivate
-- an admin or another VA, and only an admin detaches designer-business links.
-- Idempotent (DROP ... IF EXISTS), policies only; no data touched.
DROP POLICY IF EXISTS "user_insert" ON "user";--> statement-breakpoint
CREATE POLICY "user_insert" ON "user" FOR INSERT
  WITH CHECK (app_is_admin() OR (app_role() = 'va' AND role::text = 'designer'));--> statement-breakpoint
DROP POLICY IF EXISTS "user_update" ON "user";--> statement-breakpoint
CREATE POLICY "user_update" ON "user" FOR UPDATE
  USING (app_is_admin() OR id = app_user_id() OR (app_role() = 'va' AND role::text = 'designer'))
  WITH CHECK (
    app_is_admin()
    OR (id = app_user_id() AND role::text = app_role())
    -- A VA may flip a designer's active flag / session validity, never the role.
    OR (app_role() = 'va' AND role::text = 'designer')
  );--> statement-breakpoint
DROP POLICY IF EXISTS "designer_businesses_insert" ON "designer_businesses";--> statement-breakpoint
CREATE POLICY "designer_businesses_insert" ON "designer_businesses" FOR INSERT
  WITH CHECK (
    app_is_admin()
    OR (app_role() = 'va' AND EXISTS (
      SELECT 1 FROM "user" u WHERE u.id = user_id AND u.role::text = 'designer'
    ))
  );
