ALTER TYPE "public"."earnings_status" ADD VALUE 'blocked' BEFORE 'pending';--> statement-breakpoint
ALTER TABLE "earnings" ADD COLUMN "breakdown" jsonb;--> statement-breakpoint
ALTER TABLE "earnings" ADD COLUMN "blocked_reason" text;--> statement-breakpoint
ALTER TABLE "earnings" ADD COLUMN "paid_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "earnings" ADD COLUMN "paid_by" text;--> statement-breakpoint
ALTER TABLE "earnings" ADD COLUMN "voided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "earnings" ADD COLUMN "voided_by" text;--> statement-breakpoint
ALTER TABLE "earnings" ADD COLUMN "void_reason" text;--> statement-breakpoint
ALTER TABLE "styles" ADD COLUMN "per_figure_rate" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "earnings" ADD CONSTRAINT "earnings_paid_by_user_id_fk" FOREIGN KEY ("paid_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "earnings" ADD CONSTRAINT "earnings_voided_by_user_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;