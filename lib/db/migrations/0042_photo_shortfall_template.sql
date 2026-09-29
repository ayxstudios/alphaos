-- Agent-first phase 1: the agent drafts a "more photos needed" email when an
-- order has fewer reference photos than figures ordered. Idempotent like 0034.
ALTER TYPE "public"."email_template_key" ADD VALUE IF NOT EXISTS 'photo_shortfall';
