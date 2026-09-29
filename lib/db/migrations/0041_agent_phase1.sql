-- Agent-first phase 1 (docs/AGENT_FIRST.md): per-business agent switches and the
-- exceptions inbox the agent raises when it needs a human. Both switches default
-- OFF and this migration never turns one on. Idempotent, like 0036-0040.
ALTER TABLE "businesses" ADD COLUMN IF NOT EXISTS "agent_intake_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN IF NOT EXISTS "agent_assign_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- kind and status stay text (not enums) so later kinds need no migration.
-- kind now: 'photo_count_mismatch', 'intake_unparsed'. status: 'open' | 'resolved'.
CREATE TABLE IF NOT EXISTS "exceptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" text NOT NULL,
	"order_id" text,
	"kind" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"summary" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" text,
	"resolution_note" text
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "exceptions" ADD CONSTRAINT "exceptions_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "exceptions" ADD CONSTRAINT "exceptions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "exceptions" ADD CONSTRAINT "exceptions_resolved_by_user_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "exceptions_business_status_idx" ON "exceptions" USING btree ("business_id","status");--> statement-breakpoint
-- One OPEN exception per order and kind; the agent re-checking an order is a no-op.
CREATE UNIQUE INDEX IF NOT EXISTS "exceptions_open_order_kind_uq" ON "exceptions" USING btree ("order_id","kind") WHERE "status" = 'open' AND "order_id" IS NOT NULL;--> statement-breakpoint
-- Staff only (VA, admin and system jobs run as admin); designers never see it.
ALTER TABLE "exceptions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "exceptions_all" ON "exceptions";--> statement-breakpoint
CREATE POLICY "exceptions_all" ON "exceptions" FOR ALL
  USING (app_is_staff()) WITH CHECK (app_is_staff());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "exceptions" TO app_user;
