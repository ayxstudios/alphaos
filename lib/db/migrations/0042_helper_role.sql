-- Designer helpers (Yousif 2026-10-01): a designer can share their board with
-- their own team. A helper works that designer's orders (moves cards, comments,
-- uploads finished portraits) and can NEVER see pay. The app gates live in
-- lib/team/helpers.ts and lib/orders/board-data.ts; these policies are the real
-- boundary.
--   * role 'helper' + user.helper_for (the principal designer).
--   * A helper resolves to its principal's id through app_principal_id(); each
--     fulfilment table gets a *_helper_* policy that mirrors the designer one,
--     keyed on the principal. Policies are permissive, so they OR with the
--     existing ones and nothing existing changes.
--   * NO policy at all for helpers on: earnings, designer_profiles (rate, rank,
--     capacity), messages, customers (customer_public first name only), and
--     every staff-only table. With RLS on and no matching policy that is zero
--     access.
--   * A designer may add, rename and deactivate their OWN helpers (user rows
--     with helper_for = themselves), never any other role.
-- Idempotent (IF NOT EXISTS / DROP ... IF EXISTS / CREATE OR REPLACE). The new
-- enum value is only compared as text here, so it is safe in the same migration.
ALTER TYPE "public"."user_role" ADD VALUE IF NOT EXISTS 'helper';--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "helper_for" text;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_helper_for_user_id_fk') THEN
    ALTER TABLE "user" ADD CONSTRAINT "user_helper_for_user_id_fk"
      FOREIGN KEY ("helper_for") REFERENCES "user"("id") ON DELETE SET NULL;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_helper_for_idx" ON "user" ("helper_for") WHERE "helper_for" IS NOT NULL;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Policy helpers: the helper's principal designer (NULL for anyone else)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_principal_id() RETURNS text
  LANGUAGE sql STABLE AS $$
    SELECT u.helper_for FROM "user" u
    WHERE u.id = current_setting('app.user_id', true)
      AND current_setting('app.role', true) = 'helper'
      AND u.active
  $$;--> statement-breakpoint

-- Is the helper's principal attached to this business?
CREATE OR REPLACE FUNCTION app_helper_business(bid text) RETURNS boolean
  LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
      SELECT 1 FROM designer_businesses db
      WHERE db.user_id = app_principal_id()
        AND db.business_id = bid
    )
  $$;--> statement-breakpoint

-- Is the helper's principal the ACTIVE assignee of this order?
CREATE OR REPLACE FUNCTION app_helper_assigned(oid text) RETURNS boolean
  LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
      SELECT 1 FROM assignments a
      WHERE a.order_id = oid
        AND a.designer_id = app_principal_id()
        AND a.active
    )
  $$;--> statement-breakpoint

-- designer_businesses: the helper reads its principal's rows (the two helper
-- functions above run as the caller and read this table).
DROP POLICY IF EXISTS "designer_businesses_helper_select" ON "designer_businesses";--> statement-breakpoint
CREATE POLICY "designer_businesses_helper_select" ON "designer_businesses" FOR SELECT
  USING (user_id = app_principal_id());--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Fulfilment tables: a helper mirrors the designer policy, on the principal
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "businesses_helper_select" ON "businesses";--> statement-breakpoint
CREATE POLICY "businesses_helper_select" ON "businesses" FOR SELECT
  USING (app_helper_business(id));--> statement-breakpoint

DROP POLICY IF EXISTS "shops_helper_select" ON "shops";--> statement-breakpoint
CREATE POLICY "shops_helper_select" ON "shops" FOR SELECT
  USING (app_helper_business(business_id));--> statement-breakpoint

DROP POLICY IF EXISTS "orders_helper_select" ON "orders";--> statement-breakpoint
CREATE POLICY "orders_helper_select" ON "orders" FOR SELECT
  USING (app_helper_business(business_id) AND app_helper_assigned(id));--> statement-breakpoint
DROP POLICY IF EXISTS "orders_helper_update" ON "orders";--> statement-breakpoint
CREATE POLICY "orders_helper_update" ON "orders" FOR UPDATE
  USING (app_helper_business(business_id) AND app_helper_assigned(id))
  WITH CHECK (app_helper_business(business_id) AND app_helper_assigned(id));--> statement-breakpoint

DROP POLICY IF EXISTS "order_items_helper_select" ON "order_items";--> statement-breakpoint
CREATE POLICY "order_items_helper_select" ON "order_items" FOR SELECT
  USING (app_helper_business(business_id) AND app_helper_assigned(order_id));--> statement-breakpoint

DROP POLICY IF EXISTS "assets_helper_select" ON "assets";--> statement-breakpoint
CREATE POLICY "assets_helper_select" ON "assets" FOR SELECT
  USING (app_helper_business(business_id) AND app_helper_assigned(order_id));--> statement-breakpoint
-- Same narrowing as the designer's (0040): a finished portrait, uploaded by the
-- helper themselves (the audit trail names who really did it).
DROP POLICY IF EXISTS "assets_helper_insert" ON "assets";--> statement-breakpoint
CREATE POLICY "assets_helper_insert" ON "assets" FOR INSERT
  WITH CHECK (
    app_helper_business(business_id)
    AND app_helper_assigned(order_id)
    AND uploaded_by = app_user_id()
    AND type = 'submission'
  );--> statement-breakpoint

DROP POLICY IF EXISTS "assignments_helper_select" ON "assignments";--> statement-breakpoint
CREATE POLICY "assignments_helper_select" ON "assignments" FOR SELECT
  USING (designer_id = app_principal_id());--> statement-breakpoint

DROP POLICY IF EXISTS "qc_checks_helper_select" ON "qc_checks";--> statement-breakpoint
CREATE POLICY "qc_checks_helper_select" ON "qc_checks" FOR SELECT
  USING (app_helper_business(business_id) AND app_helper_assigned(order_id));--> statement-breakpoint

DROP POLICY IF EXISTS "proofs_helper_select" ON "proofs";--> statement-breakpoint
CREATE POLICY "proofs_helper_select" ON "proofs" FOR SELECT
  USING (app_helper_business(business_id) AND app_helper_assigned(order_id));--> statement-breakpoint

DROP POLICY IF EXISTS "print_jobs_helper_select" ON "print_jobs";--> statement-breakpoint
CREATE POLICY "print_jobs_helper_select" ON "print_jobs" FOR SELECT
  USING (app_helper_business(business_id) AND app_helper_assigned(order_id));--> statement-breakpoint

-- activity_log: read the principal's orders; append only as themselves.
DROP POLICY IF EXISTS "activity_log_helper_select" ON "activity_log";--> statement-breakpoint
CREATE POLICY "activity_log_helper_select" ON "activity_log" FOR SELECT
  USING (
    order_id IS NOT NULL
    AND app_helper_business(business_id)
    AND app_helper_assigned(order_id)
  );--> statement-breakpoint
DROP POLICY IF EXISTS "activity_log_helper_insert" ON "activity_log";--> statement-breakpoint
CREATE POLICY "activity_log_helper_insert" ON "activity_log" FOR INSERT
  WITH CHECK (
    app_helper_business(business_id)
    AND actor_id = app_user_id()
    AND order_id IS NOT NULL
    AND app_helper_assigned(order_id)
  );--> statement-breakpoint

-- customer_public: first names only, for customers of the principal's orders
-- (the designer branch of 0040 plus the helper branch).
CREATE OR REPLACE VIEW customer_public
  WITH (security_invoker = false) AS
  SELECT c.id, c.business_id, c.first_name
  FROM customers c
  WHERE app_is_staff()
     OR (app_designer_business(c.business_id)
         AND EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id AND app_designer_assigned(o.id)))
     OR (app_helper_business(c.business_id)
         AND EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id AND app_helper_assigned(o.id)));--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- "user": a designer manages their OWN helpers (add, rename, deactivate, end
-- sessions). The rows must be role 'helper' pointing at themselves; a designer
-- cannot create or edit any other role through this policy.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "user_helper_insert" ON "user";--> statement-breakpoint
CREATE POLICY "user_helper_insert" ON "user" FOR INSERT
  WITH CHECK (app_role() = 'designer' AND role::text = 'helper' AND helper_for = app_user_id());--> statement-breakpoint
DROP POLICY IF EXISTS "user_helper_update" ON "user";--> statement-breakpoint
CREATE POLICY "user_helper_update" ON "user" FOR UPDATE
  USING (app_role() = 'designer' AND role::text = 'helper' AND helper_for = app_user_id())
  WITH CHECK (app_role() = 'designer' AND role::text = 'helper' AND helper_for = app_user_id());
