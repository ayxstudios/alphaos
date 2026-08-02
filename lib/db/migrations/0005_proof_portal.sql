CREATE TABLE "rate_limits" (
	"bucket" text PRIMARY KEY NOT NULL,
	"hits" integer DEFAULT 0 NOT NULL,
	"window_start" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "logo_url" text;--> statement-breakpoint
ALTER TABLE "proofs" ADD COLUMN "first_viewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "proofs" ADD COLUMN "decided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "proofs" ADD COLUMN "failed_items" jsonb;--> statement-breakpoint
ALTER TABLE "proofs" ADD COLUMN "annotations" jsonb;--> statement-breakpoint
-- rate_limits holds no tenant data and is written from the public proof portal,
-- so it intentionally has NO row-level security. The app connects as the
-- non-owner app_user; ALTER DEFAULT PRIVILEGES (migration 0001) already grants
-- on tables created later, but grant explicitly so this is self-evident.
GRANT SELECT, INSERT, UPDATE, DELETE ON "rate_limits" TO app_user;