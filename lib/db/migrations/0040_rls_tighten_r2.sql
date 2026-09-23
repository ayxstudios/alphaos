-- Security QA round 2, remaining RLS P2s (docs/QA-2026-09-23-security-r2.md,
-- "Remaining P2"). Each policy below granted more than any app path uses; each
-- is narrowed to what the app does today and covered by `npm run test:rls`.
-- Policies, one view and grants only; no data touched. Idempotent (DROP ...
-- IF EXISTS / CREATE OR REPLACE / REVOKE). Brief locks on the tables named.
-- The P2s NOT changed here (alpha_events, orders column scope, raw_import,
-- shop ciphertext, earnings updates) are explained under "Decisions" in that doc.

-- 1. "user": RLS on. SELECT stays open (sign-in, the per-request session
--    re-check and sign-in links read it with no request context). Writes: an
--    admin (team panel, add designer, system jobs) or the person's own row
--    (tour progress, sign-out revocation) WITHOUT changing their own role.
ALTER TABLE "user" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "user_select" ON "user";--> statement-breakpoint
CREATE POLICY "user_select" ON "user" FOR SELECT USING (true);--> statement-breakpoint
DROP POLICY IF EXISTS "user_insert" ON "user";--> statement-breakpoint
CREATE POLICY "user_insert" ON "user" FOR INSERT WITH CHECK (app_is_admin());--> statement-breakpoint
DROP POLICY IF EXISTS "user_update" ON "user";--> statement-breakpoint
CREATE POLICY "user_update" ON "user" FOR UPDATE
  USING (app_is_admin() OR id = app_user_id())
  WITH CHECK (app_is_admin() OR (id = app_user_id() AND role::text = app_role()));--> statement-breakpoint
DROP POLICY IF EXISTS "user_delete" ON "user";--> statement-breakpoint
CREATE POLICY "user_delete" ON "user" FOR DELETE USING (app_is_admin());--> statement-breakpoint

-- 2. designer_businesses: RLS on. Staff read all (assignment, reports); a
--    designer reads only their own rows (app_designer_business() runs as the
--    caller, so it keeps working). Only an admin attaches or detaches.
ALTER TABLE "designer_businesses" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "designer_businesses_select" ON "designer_businesses";--> statement-breakpoint
CREATE POLICY "designer_businesses_select" ON "designer_businesses" FOR SELECT
  USING (app_is_staff() OR user_id = app_user_id());--> statement-breakpoint
DROP POLICY IF EXISTS "designer_businesses_insert" ON "designer_businesses";--> statement-breakpoint
CREATE POLICY "designer_businesses_insert" ON "designer_businesses" FOR INSERT WITH CHECK (app_is_admin());--> statement-breakpoint
DROP POLICY IF EXISTS "designer_businesses_update" ON "designer_businesses";--> statement-breakpoint
CREATE POLICY "designer_businesses_update" ON "designer_businesses" FOR UPDATE
  USING (app_is_admin()) WITH CHECK (app_is_admin());--> statement-breakpoint
DROP POLICY IF EXISTS "designer_businesses_delete" ON "designer_businesses";--> statement-breakpoint
CREATE POLICY "designer_businesses_delete" ON "designer_businesses" FOR DELETE USING (app_is_admin());--> statement-breakpoint

-- 3. customer_public: a designer saw the first name of EVERY customer in their
--    businesses; now only customers of orders assigned to them (the board and
--    card are the only designer readers). Same columns, same owner semantics.
CREATE OR REPLACE VIEW customer_public
  WITH (security_invoker = false) AS
  SELECT c.id, c.business_id, c.first_name
  FROM customers c
  WHERE app_is_staff()
     OR (app_designer_business(c.business_id)
         AND EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id AND app_designer_assigned(o.id)));--> statement-breakpoint

-- 4. activity_log_insert: a designer could write a row with any actor_id, or
--    one on an order not assigned to them. Designer rows (transitions,
--    comments, uploads) always carry their own id on an assigned order.
DROP POLICY IF EXISTS "activity_log_insert" ON "activity_log";--> statement-breakpoint
CREATE POLICY "activity_log_insert" ON "activity_log" FOR INSERT
  WITH CHECK (
    app_is_staff()
    OR (app_designer_business(business_id)
        AND actor_id = app_user_id()
        AND order_id IS NOT NULL
        AND app_designer_assigned(order_id))
  );--> statement-breakpoint

-- 5. assets_designer_insert: a designer could insert any asset type with any
--    uploaded_by. The only designer upload is their own finished portrait.
DROP POLICY IF EXISTS "assets_designer_insert" ON "assets";--> statement-breakpoint
CREATE POLICY "assets_designer_insert" ON "assets" FOR INSERT
  WITH CHECK (
    app_is_staff()
    OR (app_designer_business(business_id)
        AND app_designer_assigned(order_id)
        AND uploaded_by = app_user_id()
        AND type = 'submission')
  );--> statement-breakpoint

-- 6. notifications: nobody deletes one in the app (read = read_at); only an
--    admin (or a system job) may. notification_channels has no app reader or
--    writer at all: admin/system only.
DROP POLICY IF EXISTS "notifications_delete" ON "notifications";--> statement-breakpoint
CREATE POLICY "notifications_delete" ON "notifications" FOR DELETE USING (app_is_admin());--> statement-breakpoint
DROP POLICY IF EXISTS "notification_channels_all" ON "notification_channels";--> statement-breakpoint
CREATE POLICY "notification_channels_all" ON "notification_channels" FOR ALL
  USING (app_is_admin()) WITH CHECK (app_is_admin());--> statement-breakpoint

-- 7. VA policies are FOR ALL, so a VA could DELETE orders, customers, messages,
--    assignments, proofs, print jobs, assets and earnings. No VA path deletes
--    (orders are cancelled/archived, assets soft-deleted, assignments made
--    inactive). A RESTRICTIVE policy keeps every existing permission and adds
--    "DELETE needs admin" on top. FK cascades are not subject to RLS.
DROP POLICY IF EXISTS "orders_delete_admin_only" ON "orders";--> statement-breakpoint
CREATE POLICY "orders_delete_admin_only" ON "orders" AS RESTRICTIVE FOR DELETE USING (app_is_admin());--> statement-breakpoint
DROP POLICY IF EXISTS "customers_delete_admin_only" ON "customers";--> statement-breakpoint
CREATE POLICY "customers_delete_admin_only" ON "customers" AS RESTRICTIVE FOR DELETE USING (app_is_admin());--> statement-breakpoint
DROP POLICY IF EXISTS "messages_delete_admin_only" ON "messages";--> statement-breakpoint
CREATE POLICY "messages_delete_admin_only" ON "messages" AS RESTRICTIVE FOR DELETE USING (app_is_admin());--> statement-breakpoint
DROP POLICY IF EXISTS "assignments_delete_admin_only" ON "assignments";--> statement-breakpoint
CREATE POLICY "assignments_delete_admin_only" ON "assignments" AS RESTRICTIVE FOR DELETE USING (app_is_admin());--> statement-breakpoint
DROP POLICY IF EXISTS "proofs_delete_admin_only" ON "proofs";--> statement-breakpoint
CREATE POLICY "proofs_delete_admin_only" ON "proofs" AS RESTRICTIVE FOR DELETE USING (app_is_admin());--> statement-breakpoint
DROP POLICY IF EXISTS "print_jobs_delete_admin_only" ON "print_jobs";--> statement-breakpoint
CREATE POLICY "print_jobs_delete_admin_only" ON "print_jobs" AS RESTRICTIVE FOR DELETE USING (app_is_admin());--> statement-breakpoint
DROP POLICY IF EXISTS "assets_delete_admin_only" ON "assets";--> statement-breakpoint
CREATE POLICY "assets_delete_admin_only" ON "assets" AS RESTRICTIVE FOR DELETE USING (app_is_admin());--> statement-breakpoint
DROP POLICY IF EXISTS "earnings_delete_admin_only" ON "earnings";--> statement-breakpoint
CREATE POLICY "earnings_delete_admin_only" ON "earnings" AS RESTRICTIVE FOR DELETE USING (app_is_admin());--> statement-breakpoint

-- 8. Auth.js adapter tables: sessions are JWTs (no adapter), nothing reads or
--    writes these. The app role loses all access; the tables stay for the
--    schema (FK cascades from "user" still run, as the owner).
REVOKE ALL ON "account" FROM app_user;--> statement-breakpoint
REVOKE ALL ON "session" FROM app_user;--> statement-breakpoint
REVOKE ALL ON "verification_token" FROM app_user;
