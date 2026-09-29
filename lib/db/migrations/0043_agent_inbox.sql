-- Agent-first phase 2 (docs/AGENT_FIRST.md): the agent runs the inbox. One more
-- per-business switch (default OFF, never turned on here) and a small jsonb bag
-- of agent tunables (replyConfidenceThreshold, proofReminderAfterHours, ...);
-- lib/agent/config.ts fills in the defaults. Idempotent, like 0041.
ALTER TABLE "businesses" ADD COLUMN IF NOT EXISTS "agent_inbox_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN IF NOT EXISTS "agent_config" jsonb DEFAULT '{}'::jsonb NOT NULL;
