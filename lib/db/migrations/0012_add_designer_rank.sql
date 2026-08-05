ALTER TABLE "designer_profiles" ADD COLUMN "rank" integer DEFAULT 1000 NOT NULL;--> statement-breakpoint
-- Widen designer-profile edits from admin-only to ALL staff (admin + VA), so VAs
-- can manage the Designers page (rank, daily limit, styles). A designer may still
-- edit their own profile row. Read policy (staff read all) is unchanged.
DROP POLICY IF EXISTS "designer_profiles_modify" ON "designer_profiles";--> statement-breakpoint
CREATE POLICY "designer_profiles_modify" ON "designer_profiles" FOR ALL
  USING (app_is_staff() OR user_id = app_user_id())
  WITH CHECK (app_is_staff() OR user_id = app_user_id());