-- Per-person sign-in links (lib/auth/login-link.ts, docs/LOGIN-LINKS.md). A link
-- is a credential: only the sha256 of its token is stored. One active link per
-- user (minting revokes the previous one); revoked on deactivation and on a
-- password reset (lib/team/manage.ts). Idempotent, like 0036-0038.
-- No RLS, like login_attempts: the "link" Credentials provider reads it before
-- any session exists. Holds no tenant data.
CREATE TABLE IF NOT EXISTS "login_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "login_links_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "login_links" ADD CONSTRAINT "login_links_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "login_links" ADD CONSTRAINT "login_links_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "login_links_user_idx" ON "login_links" USING btree ("user_id");--> statement-breakpoint
-- At most one live (unrevoked) link per user, enforced by the database too.
CREATE UNIQUE INDEX IF NOT EXISTS "login_links_one_active_uq" ON "login_links" USING btree ("user_id") WHERE "revoked_at" IS NULL;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "login_links" TO app_user;
