-- AI designer: styles opt in to the agent designer, designer_profiles flag the
-- agent row, orders track the agent loop state. Idempotent. Also seeds one
-- "AI Studio" agent designer per business.
ALTER TABLE "styles" ADD COLUMN IF NOT EXISTS "ai_designer_enabled" boolean DEFAULT false NOT NULL;
ALTER TABLE "styles" ADD COLUMN IF NOT EXISTS "ai_framework" text;
ALTER TABLE "designer_profiles" ADD COLUMN IF NOT EXISTS "is_agent" boolean DEFAULT false NOT NULL;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "ai_state" text;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "ai_claimed_at" timestamp with time zone;
CREATE INDEX IF NOT EXISTS "orders_ai_state_idx" ON "orders" ("business_id", "ai_state") WHERE "ai_state" IS NOT NULL;

-- One "AI Studio" agent designer per business. No password, so it can never sign in.
INSERT INTO "user" ("id", "name", "email", "role", "active")
SELECT gen_random_uuid()::text, 'AI Studio', 'ai-studio+' || b."id" || '@agent.invalid', 'designer', true
FROM "businesses" b
WHERE NOT EXISTS (
  SELECT 1 FROM "user" u WHERE u."email" = 'ai-studio+' || b."id" || '@agent.invalid'
);
INSERT INTO "designer_profiles" ("user_id", "is_agent", "daily_capacity", "max_active_orders")
SELECT u."id", true, 0, 0 FROM "user" u WHERE u."email" LIKE 'ai-studio+%@agent.invalid'
ON CONFLICT ("user_id") DO UPDATE SET "is_agent" = true;
INSERT INTO "designer_businesses" ("user_id", "business_id")
SELECT u."id", b."id" FROM "businesses" b
JOIN "user" u ON u."email" = 'ai-studio+' || b."id" || '@agent.invalid'
ON CONFLICT DO NOTHING;
