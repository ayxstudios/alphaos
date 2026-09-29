-- Agent-first phase 3: per-business print routing rule (docs/AGENT_FIRST.md 3.2).
-- Shape: {"default": "lumaprints"|"gelato", "overrides": [{"productType"?, "size"?, "provider"}]}.
-- An empty object means "Lumaprints for everything" (lib/print/routing.ts). Idempotent.
ALTER TABLE "businesses" ADD COLUMN IF NOT EXISTS "print_routing" jsonb DEFAULT '{}'::jsonb NOT NULL;
