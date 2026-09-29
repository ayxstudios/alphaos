// Agent tunables per business (businesses.agent_config, migration 0043), with
// defaults for anything unset or out of range. Add new keys to AgentConfigInput
// and DEFAULTS; the column is a jsonb bag so no migration is needed.
import type { AgentConfigInput } from "./config-types";

export type { AgentConfigInput } from "./config-types";

export type AgentConfig = Required<AgentConfigInput>;

export const AGENT_CONFIG_DEFAULTS: AgentConfig = {
  replyConfidenceThreshold: 0.85,
  proofReminderAfterHours: 72,
  inboxEnabledAt: null,
  inboxLookbackHours: 168,
};

function num(v: unknown, min: number, max: number, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : fallback;
}

export function getAgentConfig(business: { agentConfig?: unknown } | null | undefined): AgentConfig {
  const raw = (business?.agentConfig && typeof business.agentConfig === "object" ? business.agentConfig : {}) as Record<string, unknown>;
  return {
    replyConfidenceThreshold: num(raw.replyConfidenceThreshold, 0, 1, AGENT_CONFIG_DEFAULTS.replyConfidenceThreshold),
    proofReminderAfterHours: num(raw.proofReminderAfterHours, 1, 24 * 60, AGENT_CONFIG_DEFAULTS.proofReminderAfterHours),
    inboxEnabledAt:
      typeof raw.inboxEnabledAt === "string" && !Number.isNaN(Date.parse(raw.inboxEnabledAt)) ? raw.inboxEnabledAt : null,
    inboxLookbackHours: num(raw.inboxLookbackHours, 1, 24 * 90, AGENT_CONFIG_DEFAULTS.inboxLookbackHours),
  };
}
