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
  /** Send the agent's buyer email replies without a human tap. Default true. */
  autoSendReplies?: boolean;
  /**
   * Hold each AI-designer portrait for the owner after QC passes; the proof
   * email goes out only once the owner approves it. Default true.
   */
  aiOwnerApproval?: boolean;
  /**
   * Go-live cutoff (ISO time). Orders placed before it belong to the old
   * process: the agent, its outbox and the automatic reminders never touch
   * them. Unset = no cutoff. Orders that came from Trello are always skipped.
   */
  agentFrom?: string | null;
  /**
   * Start date for the staff to-do lists (lib/orders/todo-scope.ts). Older
   * orders/mail drop off Home, Today, QC and print queues but stay in All
   * Orders. Unset = falls back to agentFrom; both unset = no cutoff.
   */
  todoFrom?: string | null;
  /**
   * Hard ceiling on automatic (no human tap) customer emails per business per
   * rolling hour. Past it, mail stays queued and an exception is opened, so a
   * bug can never turn into a bulk send. Human-approved sends are not counted
   * against it.
   */
  maxAutoSendsPerHour?: number;
  /**
   * Approved orders that route to Gelato are set up there as DRAFT orders by
   * the agent (needs the Gelato credentials' draftOnly switch); a person
   * approves each draft in the Gelato dashboard. Anything else stays for a
   * person to submit. Default off.
   */
  printDrafts?: boolean;
  /**
   * The business's email signature, appended under every email AlphaOS sends
   * (the same block its people's Gmail adds by hand). Set by an admin; the html
   * is trusted, the text is the plain-text twin.
   */
  emailSignature?: { text: string; html: string } | null;
  /** How drafted answers sign off, e.g. "Regards,\nBrianna" (the shop's persona). Default: "Warm regards," + the team. */
  replySignOff?: string | null;
};
