CREATE TYPE "public"."email_template_key" AS ENUM('photo_request', 'proof_ready', 'revision_received');--> statement-breakpoint
CREATE TYPE "public"."message_status" AS ENUM('draft', 'queued', 'sent', 'failed', 'received');--> statement-breakpoint
CREATE TABLE "email_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"business_id" text NOT NULL,
	"key" "email_template_key" NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "gmail_credentials" jsonb;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "gmail_address" text;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "gmail_history_id" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "status" "message_status" DEFAULT 'draft' NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "template_key" "email_template_key";--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "proof_id" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "subject" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "address" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "error" text;--> statement-breakpoint
ALTER TABLE "email_templates" ADD CONSTRAINT "email_templates_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_templates" ADD CONSTRAINT "email_templates_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "email_templates_business_key_uq" ON "email_templates" USING btree ("business_id","key");--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_proof_id_proofs_id_fk" FOREIGN KEY ("proof_id") REFERENCES "public"."proofs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "messages_status_idx" ON "messages" USING btree ("status","created_at");--> statement-breakpoint
-- ===========================================================================
-- RLS for email_templates (hand-written; see 0001_rls_policies.sql for model).
--
-- Templates are staff-editable copy scoped to a business. Designers have no
-- reason to read them, so they are staff-only (admin + va). The app connects as
-- the non-owner app_user; ALTER DEFAULT PRIVILEGES (0001) already grants on
-- tables created later, but grant explicitly so this is self-evident.
--
-- gmail_credentials on businesses is an encrypted envelope; the existing
-- businesses RLS already scopes SELECT (staff, or a designer's attached
-- business), and the blob is useless without ENCRYPTION_KEY — same posture as
-- shops.credentials. No new policy needed for the added columns.
-- ===========================================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON "email_templates" TO app_user;--> statement-breakpoint
ALTER TABLE "email_templates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "email_templates_select" ON "email_templates" FOR SELECT
  USING (app_is_staff());--> statement-breakpoint
CREATE POLICY "email_templates_modify" ON "email_templates" FOR ALL
  USING (app_is_staff()) WITH CHECK (app_is_staff());