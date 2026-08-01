-- ===========================================================================
-- Row-level security for AlphaOS
--
-- MODEL
--   Application tables are owned by the migration/owner role. The application
--   connects as a dedicated NON-OWNER role ("app_user") so RLS actually applies
--   to it -- a table owner bypasses non-forced RLS; a non-owner does not.
--   Every request opens a transaction (see withUserContext in lib/db/index.ts)
--   and sets two transaction-local GUCs the policies read:
--       app.user_id  -- the acting user's id
--       app.role     -- 'admin' | 'va' | 'designer'
--
-- ROLE RULES (from CLAUDE.md)
--   admin    -> everything, all businesses
--   va       -> all orders / all boards, all businesses
--   designer -> only orders they are the ACTIVE assignee of, and only within
--               businesses they are attached to (designer_businesses); never
--               a customer's email.
--
-- REQUIRED OPS STEPS (this migration does NOT do these -- they involve secrets
-- and connection strings):
--   1. Give app_user a login out-of-band; never commit the password:
--        ALTER ROLE app_user WITH LOGIN PASSWORD '<secret>';
--      (or create/manage the role in the Neon console).
--   2. Point the app's DATABASE_URL at app_user.
--   3. Keep drizzle-kit / migrations on the OWNER connection (add a separate
--      DIRECT_URL for drizzle.config.ts).
--   Until DATABASE_URL uses app_user, these policies are DEFINED BUT NOT
--   ENFORCED, because the owner role bypasses non-forced RLS.
--
-- Auth.js tables (user, account, session, verification_token) and the config
-- junction designer_businesses intentionally have NO RLS: NextAuth queries the
-- former without a request context, and the policies below subquery the latter.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Runtime role + privileges
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user NOLOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;

-- activity_log is append-only: no UPDATE/DELETE, ever (belt-and-braces with the
-- absence of an UPDATE/DELETE policy below).
REVOKE UPDATE, DELETE ON activity_log FROM app_user;

-- ---------------------------------------------------------------------------
-- Policy helpers (read the request GUCs; STABLE so the planner can cache them)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_user_id() RETURNS text
  LANGUAGE sql STABLE AS $$ SELECT current_setting('app.user_id', true) $$;

CREATE OR REPLACE FUNCTION app_role() RETURNS text
  LANGUAGE sql STABLE AS $$ SELECT current_setting('app.role', true) $$;

CREATE OR REPLACE FUNCTION app_is_admin() RETURNS boolean
  LANGUAGE sql STABLE AS $$ SELECT current_setting('app.role', true) = 'admin' $$;

-- admin or va -- "staff" see everything across all businesses.
CREATE OR REPLACE FUNCTION app_is_staff() RETURNS boolean
  LANGUAGE sql STABLE
  AS $$ SELECT current_setting('app.role', true) IN ('admin', 'va') $$;

-- Is the current user a designer attached to this business?
CREATE OR REPLACE FUNCTION app_designer_business(bid text) RETURNS boolean
  LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
      SELECT 1 FROM designer_businesses db
      WHERE db.user_id = current_setting('app.user_id', true)
        AND db.business_id = bid
    )
  $$;

-- Is the current user the ACTIVE assignee of this order?
CREATE OR REPLACE FUNCTION app_designer_assigned(oid text) RETURNS boolean
  LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
      SELECT 1 FROM assignments a
      WHERE a.order_id = oid
        AND a.designer_id = current_setting('app.user_id', true)
        AND a.active
    )
  $$;

-- ---------------------------------------------------------------------------
-- businesses -- staff: all; designer: their attached businesses (read-only)
-- ---------------------------------------------------------------------------
ALTER TABLE businesses ENABLE ROW LEVEL SECURITY;
CREATE POLICY businesses_select ON businesses FOR SELECT
  USING (app_is_staff() OR app_designer_business(id));
CREATE POLICY businesses_modify ON businesses FOR ALL
  USING (app_is_admin()) WITH CHECK (app_is_admin());

-- ---------------------------------------------------------------------------
-- shops -- credentials are encrypted, so scoped SELECT is safe; admin writes
-- ---------------------------------------------------------------------------
ALTER TABLE shops ENABLE ROW LEVEL SECURITY;
CREATE POLICY shops_select ON shops FOR SELECT
  USING (app_is_staff() OR app_designer_business(business_id));
CREATE POLICY shops_modify ON shops FOR ALL
  USING (app_is_admin()) WITH CHECK (app_is_admin());

-- ---------------------------------------------------------------------------
-- customers -- staff only. Designers are DENIED the table entirely and read
-- the customer_public view (id, business_id, first_name) defined at the end.
-- ---------------------------------------------------------------------------
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
CREATE POLICY customers_all ON customers FOR ALL
  USING (app_is_staff()) WITH CHECK (app_is_staff());

-- ---------------------------------------------------------------------------
-- orders -- staff: all. designer: read + update their actively-assigned orders.
-- ---------------------------------------------------------------------------
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY orders_select ON orders FOR SELECT
  USING (
    app_is_staff()
    OR (app_designer_business(business_id) AND app_designer_assigned(id))
  );
CREATE POLICY orders_designer_update ON orders FOR UPDATE
  USING (
    app_is_staff()
    OR (app_designer_business(business_id) AND app_designer_assigned(id))
  )
  WITH CHECK (
    app_is_staff()
    OR (app_designer_business(business_id) AND app_designer_assigned(id))
  );
CREATE POLICY orders_insert ON orders FOR INSERT
  WITH CHECK (app_is_staff());
CREATE POLICY orders_delete ON orders FOR DELETE
  USING (app_is_staff());

-- ---------------------------------------------------------------------------
-- order_items -- follows the parent order's visibility; staff-only writes
-- ---------------------------------------------------------------------------
ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY order_items_select ON order_items FOR SELECT
  USING (
    app_is_staff()
    OR (app_designer_business(business_id) AND app_designer_assigned(order_id))
  );
CREATE POLICY order_items_modify ON order_items FOR ALL
  USING (app_is_staff()) WITH CHECK (app_is_staff());

-- ---------------------------------------------------------------------------
-- assets -- designers read their order's assets and upload submissions
-- ---------------------------------------------------------------------------
ALTER TABLE assets ENABLE ROW LEVEL SECURITY;
CREATE POLICY assets_select ON assets FOR SELECT
  USING (
    app_is_staff()
    OR (app_designer_business(business_id) AND app_designer_assigned(order_id))
  );
CREATE POLICY assets_designer_insert ON assets FOR INSERT
  WITH CHECK (
    app_is_staff()
    OR (app_designer_business(business_id) AND app_designer_assigned(order_id))
  );
CREATE POLICY assets_staff_write ON assets FOR UPDATE
  USING (app_is_staff()) WITH CHECK (app_is_staff());
CREATE POLICY assets_staff_delete ON assets FOR DELETE
  USING (app_is_staff());

-- ---------------------------------------------------------------------------
-- assignments -- staff: all. designer: their own rows (board + history).
-- Designers do not write assignments; VAs reassign.
-- ---------------------------------------------------------------------------
ALTER TABLE assignments ENABLE ROW LEVEL SECURITY;
CREATE POLICY assignments_select ON assignments FOR SELECT
  USING (app_is_staff() OR designer_id = app_user_id());
CREATE POLICY assignments_modify ON assignments FOR ALL
  USING (app_is_staff()) WITH CHECK (app_is_staff());

-- ---------------------------------------------------------------------------
-- qc_checks / proofs / messages / print_jobs -- read follows the order;
-- staff-only writes
-- ---------------------------------------------------------------------------
ALTER TABLE qc_checks ENABLE ROW LEVEL SECURITY;
CREATE POLICY qc_checks_select ON qc_checks FOR SELECT
  USING (
    app_is_staff()
    OR (app_designer_business(business_id) AND app_designer_assigned(order_id))
  );
CREATE POLICY qc_checks_modify ON qc_checks FOR ALL
  USING (app_is_staff()) WITH CHECK (app_is_staff());

ALTER TABLE proofs ENABLE ROW LEVEL SECURITY;
CREATE POLICY proofs_select ON proofs FOR SELECT
  USING (
    app_is_staff()
    OR (app_designer_business(business_id) AND app_designer_assigned(order_id))
  );
CREATE POLICY proofs_modify ON proofs FOR ALL
  USING (app_is_staff()) WITH CHECK (app_is_staff());

ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY messages_select ON messages FOR SELECT
  USING (
    app_is_staff()
    OR (
      order_id IS NOT NULL
      AND app_designer_business(business_id)
      AND app_designer_assigned(order_id)
    )
  );
CREATE POLICY messages_modify ON messages FOR ALL
  USING (app_is_staff()) WITH CHECK (app_is_staff());

ALTER TABLE print_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY print_jobs_select ON print_jobs FOR SELECT
  USING (
    app_is_staff()
    OR (app_designer_business(business_id) AND app_designer_assigned(order_id))
  );
CREATE POLICY print_jobs_modify ON print_jobs FOR ALL
  USING (app_is_staff()) WITH CHECK (app_is_staff());

-- ---------------------------------------------------------------------------
-- earnings -- staff: all. designer: their own rows, read-only.
-- ---------------------------------------------------------------------------
ALTER TABLE earnings ENABLE ROW LEVEL SECURITY;
CREATE POLICY earnings_select ON earnings FOR SELECT
  USING (app_is_staff() OR designer_id = app_user_id());
CREATE POLICY earnings_modify ON earnings FOR ALL
  USING (app_is_staff()) WITH CHECK (app_is_staff());

-- ---------------------------------------------------------------------------
-- activity_log -- append-only. Designers may read/append entries for orders
-- they are assigned to; no UPDATE/DELETE policy => immutable.
-- ---------------------------------------------------------------------------
ALTER TABLE activity_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY activity_log_select ON activity_log FOR SELECT
  USING (
    app_is_staff()
    OR (
      order_id IS NOT NULL
      AND app_designer_business(business_id)
      AND app_designer_assigned(order_id)
    )
  );
CREATE POLICY activity_log_insert ON activity_log FOR INSERT
  WITH CHECK (app_is_staff() OR app_designer_business(business_id));

-- ---------------------------------------------------------------------------
-- notifications / notification_channels -- personal to a user (admin may read)
-- ---------------------------------------------------------------------------
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY notifications_select ON notifications FOR SELECT
  USING (app_is_admin() OR user_id = app_user_id());
CREATE POLICY notifications_insert ON notifications FOR INSERT
  WITH CHECK (app_is_staff());
CREATE POLICY notifications_update ON notifications FOR UPDATE
  USING (app_is_admin() OR user_id = app_user_id())
  WITH CHECK (app_is_admin() OR user_id = app_user_id());
CREATE POLICY notifications_delete ON notifications FOR DELETE
  USING (app_is_admin() OR user_id = app_user_id());

ALTER TABLE notification_channels ENABLE ROW LEVEL SECURITY;
CREATE POLICY notification_channels_all ON notification_channels FOR ALL
  USING (app_is_admin() OR user_id = app_user_id())
  WITH CHECK (app_is_admin() OR user_id = app_user_id());

-- ---------------------------------------------------------------------------
-- designer_profiles -- staff read all; a designer reads/edits their own
-- ---------------------------------------------------------------------------
ALTER TABLE designer_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY designer_profiles_select ON designer_profiles FOR SELECT
  USING (app_is_staff() OR user_id = app_user_id());
CREATE POLICY designer_profiles_modify ON designer_profiles FOR ALL
  USING (app_is_admin() OR user_id = app_user_id())
  WITH CHECK (app_is_admin() OR user_id = app_user_id());

-- ---------------------------------------------------------------------------
-- customer_public -- designer-safe projection of customers.
--
-- security_invoker = false: the view runs as its OWNER, which bypasses the
-- customers table RLS (so designers, denied the base table, can still read a
-- first name). Tenancy is re-applied in the view body via the GUC helpers, and
-- the column list omits email/last_name -- a real DB-level guarantee, not a
-- query convention.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW customer_public
  WITH (security_invoker = false) AS
  SELECT c.id, c.business_id, c.first_name
  FROM customers c
  WHERE app_is_staff() OR app_designer_business(c.business_id);

GRANT SELECT ON customer_public TO app_user;
