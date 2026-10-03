-- Email dedupe. Idempotent.
-- messages.dedupe_key: one customer mail per (order, template, stage entry). The
-- unique index drops a second insert with the same key, so re-entering a stage
-- through an internal move (reassign, AI job re-list, reset) never mails twice.
-- messages.send_claimed_at: claimed for the seconds a send is in flight so two
-- passes (flush + retry, two ticks) never both send the same row.
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "dedupe_key" text;
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "send_claimed_at" timestamp with time zone;
--> statement-breakpoint
-- Backfill: the earliest live stage email per (order, template) owns the key, so
-- an order that already got its "in design" mail is not mailed it again.
UPDATE "messages" m SET "dedupe_key" = 'stage:' || m."order_id" || ':' || m."template_key"
FROM (
  SELECT id, row_number() OVER (PARTITION BY order_id, template_key ORDER BY (status = 'sent') DESC, created_at, id) AS rn
  FROM "messages"
  WHERE direction = 'outbound' AND order_id IS NOT NULL AND dedupe_key IS NULL
    AND template_key::text IN ('in_design', 'printing', 'order_received', 'photo_request')
) x
WHERE m.id = x.id AND x.rn = 1;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "messages_dedupe_key_uq" ON "messages" ("dedupe_key") WHERE "dedupe_key" IS NOT NULL;
