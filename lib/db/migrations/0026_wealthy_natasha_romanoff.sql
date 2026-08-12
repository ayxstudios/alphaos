ALTER TYPE "public"."email_template_key" ADD VALUE 'proof_ready_digital_single';--> statement-breakpoint
ALTER TYPE "public"."email_template_key" ADD VALUE 'proof_ready_digital_multi';--> statement-breakpoint
ALTER TYPE "public"."email_template_key" ADD VALUE 'proof_ready_physical_single';--> statement-breakpoint
ALTER TYPE "public"."email_template_key" ADD VALUE 'proof_ready_physical_multi';--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "attachment_asset_id" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "attachment_filename" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "attachment_content_type" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "attachment_size_bytes" integer;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "metadata" jsonb;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "manual_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "manual_sent_by" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "manual_sent_reason" text;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_attachment_asset_id_assets_id_fk" FOREIGN KEY ("attachment_asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_manual_sent_by_user_id_fk" FOREIGN KEY ("manual_sent_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;