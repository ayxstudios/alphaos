CREATE TABLE "styles" (
	"id" text PRIMARY KEY NOT NULL,
	"business_id" text NOT NULL,
	"name" text NOT NULL,
	"title_matches" text[] DEFAULT '{}'::text[] NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "styles" ADD CONSTRAINT "styles_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "styles_business_name_uq" ON "styles" USING btree ("business_id",lower("name"));--> statement-breakpoint
CREATE INDEX "styles_business_idx" ON "styles" USING btree ("business_id");--> statement-breakpoint
-- RLS: portrait styles are business config managed by staff. Mirrors shops.
-- (Harmless no-op until DATABASE_URL points at the non-owner app_user role.)
ALTER TABLE "styles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "styles_select" ON "styles" FOR SELECT USING (app_is_staff());--> statement-breakpoint
CREATE POLICY "styles_modify" ON "styles" FOR ALL USING (app_is_staff()) WITH CHECK (app_is_staff());