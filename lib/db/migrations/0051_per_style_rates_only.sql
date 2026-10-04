-- Per-style rates only (2026-10-04, owner correction): the flat $5.00/fig from
-- 0050 applies ONLY to the Disney-style pet portrait (the "cartoon" style).
-- Every other style's rate is cleared until the owner supplies it, and a
-- figure with no rated style BLOCKS its earning again (lib/orders/earnings.ts)
-- instead of paying a default, so nothing is ever owed at a wrong rate.
--
-- Existing earnings: 'paid' and 'voided' rows are history and are NOT touched.
-- 'pending' rows that contain a figure whose style no longer has a rate are
-- re-blocked with their money cleared; they resolve automatically when the
-- style's rate is set (setStyleRate recalculates blocked earnings).
-- Idempotent: running it twice changes nothing the second time. Status is
-- compared as text for the same fresh-database reason as 0050.
ALTER TABLE "styles" ALTER COLUMN "per_figure_rate" DROP DEFAULT;--> statement-breakpoint
UPDATE "styles" SET "per_figure_rate" = NULL
WHERE lower("name") <> 'cartoon' AND "per_figure_rate" = 5.00;--> statement-breakpoint

-- Clear the money on breakdown elements whose style is no longer priced.
UPDATE "earnings" e
SET "breakdown" = (
  SELECT coalesce(jsonb_agg(
    CASE
      WHEN el->>'style' IS NOT NULL AND EXISTS (
        SELECT 1 FROM "styles" s
        WHERE s."business_id" = e."business_id"
          AND lower(s."name") = lower(el->>'style')
          AND s."per_figure_rate" IS NOT NULL
      ) THEN el
      WHEN coalesce(el->>'blockedReason', '') <> '' THEN el
      ELSE (el - 'rate' - 'amount')
        || jsonb_build_object(
          'rate', null, 'amount', null,
          'blockedReason', 'Style "' || coalesce(el->>'style', '?') || '" needs a per-figure rate.'
        )
    END
    ORDER BY ord
  ), '[]'::jsonb)
  FROM jsonb_array_elements(e."breakdown") WITH ORDINALITY AS t(el, ord)
)
WHERE e."status"::text = 'pending'
  AND e."breakdown" IS NOT NULL
  AND jsonb_typeof(e."breakdown") = 'array';--> statement-breakpoint

-- Re-block pending rows that now contain an unpriced figure.
UPDATE "earnings" e
SET "status" = 'blocked', "rate" = NULL, "amount" = NULL,
    "blocked_reason" = (
      SELECT string_agg(DISTINCT el->>'blockedReason', ' ')
      FROM jsonb_array_elements(e."breakdown") el
      WHERE coalesce(el->>'blockedReason', '') <> ''
    )
WHERE e."status"::text = 'pending'
  AND e."breakdown" IS NOT NULL
  AND jsonb_typeof(e."breakdown") = 'array'
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(e."breakdown") el
    WHERE coalesce(el->>'blockedReason', '') <> ''
  );
