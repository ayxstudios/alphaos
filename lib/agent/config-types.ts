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
  /**
   * Which sales channels the agent works. Unset = follow the business's active
   * shops (Etsy shop present -> etsy on). An explicit false turns a channel off.
   */
  channels?: { etsy?: boolean; shopify?: boolean };
  /**
   * The mailbox the agent reads and sends from. Each business has one connected
   * Gmail account; `readInbox` false stops the agent reading buyer replies,
   * `sendFrom` pins the address it sends from (must match the connected one).
   */
  mailbox?: { readInbox?: boolean; sendFrom?: string | null };
  /**
   * Stage-email template keys that send by themselves. Everything else (and the
   * default, empty list) is a draft for one-tap approval (docs/AGENT_FIRST.md 5).
   */
  autoSendTemplates?: string[];
};
