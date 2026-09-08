CREATE TABLE "alpha_events" (
	"id" text PRIMARY KEY NOT NULL,
	"business_id" text,
	"order_id" text,
	"type" text NOT NULL,
	"to_user_id" text,
	"to_role" text,
	"text" text NOT NULL,
	"payload" jsonb,
	"status" text DEFAULT 'queued' NOT NULL,
	"delivered_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "alpha_events" ADD CONSTRAINT "alpha_events_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alpha_events" ADD CONSTRAINT "alpha_events_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alpha_events" ADD CONSTRAINT "alpha_events_to_user_id_user_id_fk" FOREIGN KEY ("to_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alpha_events_status_idx" ON "alpha_events" USING btree ("status","created_at");