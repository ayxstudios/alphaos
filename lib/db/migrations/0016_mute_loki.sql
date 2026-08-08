CREATE TABLE "ignored_products" (
	"id" text PRIMARY KEY NOT NULL,
	"business_id" text NOT NULL,
	"sku" text,
	"title" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "style_locked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "styles" ADD COLUMN "sku_matches" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "ignored_products" ADD CONSTRAINT "ignored_products_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ignored_products_business_idx" ON "ignored_products" USING btree ("business_id");--> statement-breakpoint
-- RLS: staff-managed business config, mirrors styles.
ALTER TABLE "ignored_products" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "ignored_products_select" ON "ignored_products" FOR SELECT USING (app_is_staff());--> statement-breakpoint
CREATE POLICY "ignored_products_modify" ON "ignored_products" FOR ALL USING (app_is_staff()) WITH CHECK (app_is_staff());