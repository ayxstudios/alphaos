CREATE TABLE "order_shipping_addresses" (
	"id" text PRIMARY KEY NOT NULL,
	"business_id" text NOT NULL,
	"order_id" text NOT NULL,
	"source" text DEFAULT 'platform' NOT NULL,
	"name" text,
	"first_name" text,
	"last_name" text,
	"company" text,
	"address_line_1" text,
	"address_line_2" text,
	"city" text,
	"state" text,
	"postal_code" text,
	"country_code" text,
	"phone" text,
	"email" text,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "print_product_mappings" (
	"id" text PRIMARY KEY NOT NULL,
	"business_id" text NOT NULL,
	"shop_id" text NOT NULL,
	"provider" "print_provider" NOT NULL,
	"match_type" text DEFAULT 'sku_exact' NOT NULL,
	"source_sku" text,
	"title_contains" text,
	"variant_contains" text,
	"label" text,
	"provider_product_id" text NOT NULL,
	"provider_config" jsonb,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "print_jobs" ADD COLUMN "provider_order_id" text;--> statement-breakpoint
ALTER TABLE "print_jobs" ADD COLUMN "provider_order_number" text;--> statement-breakpoint
ALTER TABLE "print_jobs" ADD COLUMN "provider_payload" jsonb;--> statement-breakpoint
ALTER TABLE "print_jobs" ADD COLUMN "provider_response" jsonb;--> statement-breakpoint
ALTER TABLE "print_jobs" ADD COLUMN "platform_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "print_jobs" ADD COLUMN "platform_sync_error" text;--> statement-breakpoint
ALTER TABLE "print_jobs" ADD COLUMN "error" text;--> statement-breakpoint
ALTER TABLE "print_jobs" ADD COLUMN "submitted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "print_jobs" ADD COLUMN "accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "print_jobs" ADD COLUMN "rejected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "print_jobs" ADD COLUMN "shipped_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "order_shipping_addresses" ADD CONSTRAINT "order_shipping_addresses_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_shipping_addresses" ADD CONSTRAINT "order_shipping_addresses_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "print_product_mappings" ADD CONSTRAINT "print_product_mappings_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "print_product_mappings" ADD CONSTRAINT "print_product_mappings_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "order_shipping_addresses_order_uq" ON "order_shipping_addresses" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "order_shipping_addresses_business_idx" ON "order_shipping_addresses" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "print_product_mappings_shop_provider_idx" ON "print_product_mappings" USING btree ("shop_id","provider");--> statement-breakpoint
CREATE INDEX "print_product_mappings_business_idx" ON "print_product_mappings" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "print_jobs_business_status_idx" ON "print_jobs" USING btree ("business_id","status","created_at");--> statement-breakpoint
CREATE INDEX "print_jobs_provider_order_idx" ON "print_jobs" USING btree ("provider","provider_order_id");
--> statement-breakpoint
ALTER TABLE "order_shipping_addresses" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "order_shipping_addresses_select" ON "order_shipping_addresses" FOR SELECT
  USING (app_is_staff());--> statement-breakpoint
CREATE POLICY "order_shipping_addresses_modify" ON "order_shipping_addresses" FOR ALL
  USING (app_is_staff()) WITH CHECK (app_is_staff());--> statement-breakpoint
ALTER TABLE "print_product_mappings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "print_product_mappings_select" ON "print_product_mappings" FOR SELECT
  USING (app_is_staff());--> statement-breakpoint
CREATE POLICY "print_product_mappings_modify" ON "print_product_mappings" FOR ALL
  USING (app_is_staff()) WITH CHECK (app_is_staff());
