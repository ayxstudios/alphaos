-- An order stays on its designer's board (Yousif 2026-10-21: "Some designers
-- are saying some orders disappear from their alphaOS boards, can we make sure
-- this stops happening. You shouldn't really reassign orders unless they are
-- severely late or we've talked about it here").
--
-- The app guard is lib/orders/board-hold.ts; this trigger holds the same line
-- for every writer, ad-hoc SQL and scripts included. A live assignment whose
-- designer is a person (not AI Studio) on an active login may not be switched
-- off or handed to someone else in place, unless the transaction carries an
-- owner's approval (alphaos.rework_move_ok = '<who: their words>', the same
-- setting migration 0063 reads) or is handing the order back to the same
-- designer (alphaos.board_move_ok = '<order id>:<designer id>'). AI Studio's
-- orders and a deactivated designer's orders move freely.
CREATE OR REPLACE FUNCTION assignments_stay_on_board() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  holder record;
BEGIN
  IF NOT OLD.active THEN
    RETURN NEW;
  END IF;
  IF NEW.active AND NEW.designer_id = OLD.designer_id THEN
    RETURN NEW;
  END IF;
  IF coalesce(current_setting('alphaos.rework_move_ok', true), '') <> '' THEN
    RETURN NEW;
  END IF;
  IF NOT NEW.active
     AND coalesce(current_setting('alphaos.board_move_ok', true), '') = OLD.order_id || ':' || OLD.designer_id THEN
    RETURN NEW;
  END IF;
  SELECT u.name, u.active, coalesce(p.is_agent, false) AS is_agent INTO holder
    FROM "user" u LEFT JOIN designer_profiles p ON p.user_id = u.id
   WHERE u.id = OLD.designer_id;
  IF NOT FOUND OR holder.is_agent OR NOT holder.active THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'stays_on_board: order % stays with % (%); moving it off their board needs an owner''s approval',
    OLD.order_id, holder.name, OLD.designer_id
    USING ERRCODE = 'P0001',
          HINT = 'With an owner''s yes, run select set_config(''alphaos.rework_move_ok'', ''<who: their words>'', true) in the same transaction.';
END;
$$;--> statement-breakpoint
-- The hand-back mark only ever lets the same designer's fresh row in: an
-- active row for anyone else under it is refused.
CREATE OR REPLACE FUNCTION assignments_hand_back_only() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  mark text := coalesce(current_setting('alphaos.board_move_ok', true), '');
BEGIN
  IF NEW.active AND mark LIKE NEW.order_id || ':%' AND mark <> NEW.order_id || ':' || NEW.designer_id
     AND coalesce(current_setting('alphaos.rework_move_ok', true), '') = '' THEN
    RAISE EXCEPTION 'stays_on_board: order % was being handed back to its designer, not to %', NEW.order_id, NEW.designer_id
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "assignments_hand_back_only" ON "assignments";--> statement-breakpoint
CREATE TRIGGER "assignments_hand_back_only" BEFORE INSERT OR UPDATE OF "active", "designer_id" ON "assignments"
  FOR EACH ROW EXECUTE FUNCTION assignments_hand_back_only();--> statement-breakpoint
DROP TRIGGER IF EXISTS "assignments_stay_on_board" ON "assignments";--> statement-breakpoint
CREATE TRIGGER "assignments_stay_on_board" BEFORE UPDATE OF "active", "designer_id" ON "assignments"
  FOR EACH ROW EXECUTE FUNCTION assignments_stay_on_board();
