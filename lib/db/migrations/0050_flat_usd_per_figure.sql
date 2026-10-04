-- Flat designer pay (2026-10-04): every figure pays $5.00 USD. The per-style
-- override (styles.per_figure_rate) stays, but every style is set to 5.00 today
-- and new styles default to it. The calculator (lib/orders/earnings.ts) pays
-- PER_FIGURE_RATE_USD when a style has no rate, so only a missing figure count
-- blocks an earning now.
--
-- Existing earnings: 'paid' and 'voided' rows are history and are NOT touched.
-- 'pending' and 'blocked' rows are recomputed at the flat rate:
--   1. every breakdown element that has a figure count is re-priced at 5.00
--      (rate "5.00", amount figureCount x 5.00, blockedReason dropped);
--      elements blocked for a missing figure count are left as they were.
--   2. rows blocked only for a missing rate / missing style become 'pending'.
--   3. every 'pending' row gets rate 5.00 and amount figure_count x 5.00.
-- Idempotent: running it twice changes nothing the second time.
ALTER TABLE "styles" ALTER COLUMN "per_figure_rate" SET DEFAULT 5.00;--> statement-breakpoint
UPDATE "styles" SET "per_figure_rate" = 5.00 WHERE "per_figure_rate" IS DISTINCT FROM 5.00;--> statement-breakpoint

UPDATE "earnings" e
SET "breakdown" = (
  SELECT coalesce(jsonb_agg(
    CASE
      WHEN coalesce(el->>'blockedReason', '') ILIKE '%figure count%' THEN el
      ELSE (el - 'blockedReason')
        || jsonb_build_object(
          'rate', '5.00',
          'amount', ((coalesce((el->>'figureCount')::numeric, 0) * 5.00)::numeric(10,2))::text
        )
    END
    ORDER BY ord
  ), '[]'::jsonb)
  FROM jsonb_array_elements(e."breakdown") WITH ORDINALITY AS t(el, ord)
)
WHERE e."status" IN ('pending', 'blocked')
  AND e."breakdown" IS NOT NULL
  AND jsonb_typeof(e."breakdown") = 'array';--> statement-breakpoint

UPDATE "earnings"
SET "status" = 'pending', "blocked_reason" = NULL
WHERE "status" = 'blocked'
  AND "blocked_reason" IS NOT NULL
  AND ("blocked_reason" ILIKE '%per-figure rate%' OR "blocked_reason" ILIKE '%missing portrait style%')
  AND "blocked_reason" NOT ILIKE '%figure count%'
  AND "breakdown" IS NOT NULL
  AND jsonb_typeof("breakdown") = 'array'
  AND jsonb_array_length("breakdown") > 0;--> statement-breakpoint

UPDATE "earnings"
SET "rate" = 5.00, "amount" = ("figure_count" * 5.00)::numeric(10,2)
WHERE "status" = 'pending'
  AND ("rate" IS DISTINCT FROM 5.00 OR "amount" IS DISTINCT FROM ("figure_count" * 5.00)::numeric(10,2));
