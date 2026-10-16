-- Revisions and failed QC stay with their designer (Yousif 2026-10-16: "From
-- now on don't move revisions or failed QC to another designer unless I
-- approve it. It can confuse designers and often they need the source file").
--
-- The database backstop for lib/orders/rework.ts, so every writer holds the
-- same line: the app, the agent's scripts and ad-hoc SQL. An order is REWORK
-- once it has been drawn: revision_count > 0 or a submission still on file.
-- Making an assignment of a rework order active is allowed only for
--   * a designer of the order's latest assignment row (handing it back), or
--   * the designer who uploaded its latest submission still on file (they
--     have the source file; a VA uploading for someone does not count).
-- Anyone else needs an owner's approval, given in the same transaction with
--   select set_config('alphaos.rework_move_ok', '<who approved: their words>', true);
-- Transaction-local, so it never leaks to another request on the pool.
-- Switching rows off and due-date or brief edits are never touched, and a
-- first draft (never drawn, no revision) moves freely as before.
-- Add-only: no table or column change. SECURITY DEFINER so the check reads
-- every row whatever the caller's RLS context; search_path pinned. Idempotent.
CREATE OR REPLACE FUNCTION assignments_rework_stays() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  rev integer;
  drew text;
  last_at timestamptz;
BEGIN
  IF NOT NEW.active THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.active AND OLD.designer_id = NEW.designer_id THEN
    RETURN NEW;
  END IF;
  IF coalesce(current_setting('alphaos.rework_move_ok', true), '') <> '' THEN
    RETURN NEW;
  END IF;
  SELECT o.revision_count INTO rev FROM orders o WHERE o.id = NEW.order_id;
  IF coalesce(rev, 0) = 0 AND NOT EXISTS (
    SELECT 1 FROM assets s
    WHERE s.order_id = NEW.order_id AND s.type = 'submission' AND s.deleted_at IS NULL
  ) THEN
    RETURN NEW;
  END IF;
  SELECT s.uploaded_by INTO drew FROM assets s JOIN "user" u ON u.id = s.uploaded_by
  WHERE s.order_id = NEW.order_id AND s.type = 'submission' AND s.deleted_at IS NULL AND u.role = 'designer'
  ORDER BY s.created_at DESC
  LIMIT 1;
  IF drew = NEW.designer_id THEN
    RETURN NEW;
  END IF;
  SELECT max(a.created_at) INTO last_at FROM assignments a WHERE a.order_id = NEW.order_id;
  IF last_at IS NULL AND drew IS NULL THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT 1 FROM assignments a
    WHERE a.order_id = NEW.order_id AND a.created_at = last_at AND a.designer_id = NEW.designer_id
  ) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'rework_stays: order % is a revision or failed QC and stays with its designer; moving it needs an owner''s approval', NEW.order_id
    USING ERRCODE = 'P0001',
          HINT = 'With an owner''s yes, run select set_config(''alphaos.rework_move_ok'', ''<who: their words>'', true) in the same transaction.';
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "assignments_rework_stays" ON "assignments";--> statement-breakpoint
CREATE TRIGGER "assignments_rework_stays"
  BEFORE INSERT OR UPDATE OF "active", "designer_id" ON "assignments"
  FOR EACH ROW EXECUTE FUNCTION assignments_rework_stays();
