// The shape stored in businesses.agent_config (migration 0043). Every key is
// optional; getAgentConfig (./config.ts) fills in the defaults. Kept in its own
// file so lib/db/schema.ts can import the type without pulling in runtime code.
export type AgentConfigInput = {
  /** Minimum classifier confidence for the agent to act on a reply by itself. */
  replyConfidenceThreshold?: number;
  /** Hours after the latest proof before the agent drafts a proof reminder. */
  proofReminderAfterHours?: number;
  /**
   * ISO time the inbox switch was last turned on (set by the settings action).
   * The agent only handles replies received after it, so switching on never
   * floods the exceptions list with old mail.
   */
  inboxEnabledAt?: string | null;
  /** Fallback look-back window in hours when inboxEnabledAt is unset. */
  inboxLookbackHours?: number;
};
