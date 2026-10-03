// Agent tunables per business (businesses.agent_config, migration 0043), with
// defaults for anything unset or out of range. Add new keys to AgentConfigInput
// and DEFAULTS; the column is a jsonb bag so no migration is needed.
//
// Two layers: getAgentConfig(business) is the sync, defaulted read the agent
// passes use; getBusinessAgentSettings / saveAgentSettings are the full
// per-business view behind Settings > Agent (flags, channels, mailbox, print
// mix, threshold, template auto-send).
import { eq } from "drizzle-orm";

import type { Tx } from "@/lib/db";
import { businesses, shops } from "@/lib/db/schema";
import { DEFAULT_PRINT_PROVIDER, parsePrintRouting } from "@/lib/print/routing";
import type { PrintRoutingOverride, PrintRoutingProvider } from "@/lib/print/routing-types";
import type { AgentConfigInput } from "./config-types";

export type { AgentConfigInput } from "./config-types";

export type AgentConfig = Required<AgentConfigInput>;

/** Stage emails the agent can be allowed to send by itself; every other template is always a draft. */
export const AUTO_SEND_TEMPLATE_KEYS = ["order_received", "in_design", "printing", "shipped", "proof_reminder"] as const;
export type AutoSendTemplateKey = (typeof AUTO_SEND_TEMPLATE_KEYS)[number];

export const AGENT_CONFIG_DEFAULTS: AgentConfig = {
  replyConfidenceThreshold: 0.85,
  proofReminderAfterHours: 72,
  inboxEnabledAt: null,
  inboxLookbackHours: 168,
  channels: {},
  mailbox: {},
  autoSendTemplates: [],
  autoSendReplies: true,
  aiOwnerApproval: true,
  agentFrom: null,
  maxAutoSendsPerHour: 30,
  printDrafts: false,
};

function num(v: unknown, min: number, max: number, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : fallback;
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function cleanChannels(v: unknown): AgentConfig["channels"] {
  const r = obj(v);
  return {
    ...(typeof r.etsy === "boolean" ? { etsy: r.etsy } : {}),
    ...(typeof r.shopify === "boolean" ? { shopify: r.shopify } : {}),
  };
}

function cleanMailbox(v: unknown): AgentConfig["mailbox"] {
  const r = obj(v);
  return {
    ...(typeof r.readInbox === "boolean" ? { readInbox: r.readInbox } : {}),
    ...(typeof r.sendFrom === "string" && r.sendFrom.includes("@")
      ? { sendFrom: r.sendFrom.trim().toLowerCase() }
      : r.sendFrom === null
        ? { sendFrom: null }
        : {}),
  };
}

function cleanAutoSend(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const ok = new Set<string>(AUTO_SEND_TEMPLATE_KEYS);
  return Array.from(new Set(v.filter((k): k is string => typeof k === "string" && ok.has(k))));
}

export function getAgentConfig(business: { agentConfig?: unknown } | null | undefined): AgentConfig {
  const raw = obj(business?.agentConfig);
  return {
    replyConfidenceThreshold: num(raw.replyConfidenceThreshold, 0, 1, AGENT_CONFIG_DEFAULTS.replyConfidenceThreshold),
    proofReminderAfterHours: num(raw.proofReminderAfterHours, 1, 24 * 60, AGENT_CONFIG_DEFAULTS.proofReminderAfterHours),
    inboxEnabledAt:
      typeof raw.inboxEnabledAt === "string" && !Number.isNaN(Date.parse(raw.inboxEnabledAt)) ? raw.inboxEnabledAt : null,
    inboxLookbackHours: num(raw.inboxLookbackHours, 1, 24 * 90, AGENT_CONFIG_DEFAULTS.inboxLookbackHours),
    channels: cleanChannels(raw.channels),
    mailbox: cleanMailbox(raw.mailbox),
    autoSendTemplates: cleanAutoSend(raw.autoSendTemplates),
    autoSendReplies: raw.autoSendReplies !== false,
    aiOwnerApproval: raw.aiOwnerApproval !== false,
    agentFrom: typeof raw.agentFrom === "string" && !Number.isNaN(Date.parse(raw.agentFrom)) ? raw.agentFrom : null,
    maxAutoSendsPerHour: num(raw.maxAutoSendsPerHour, 1, 1000, AGENT_CONFIG_DEFAULTS.maxAutoSendsPerHour),
    printDrafts: raw.printDrafts === true,
  };
}

// ---------------------------------------------------------------------------
// The full per-business settings view (Settings > Agent)
// ---------------------------------------------------------------------------

export type AgentFlagSet = { intake: boolean; assign: boolean; inbox: boolean };

export type AgentSettings = {
  businessId: string;
  flags: AgentFlagSet;
  channels: { etsy: boolean; shopify: boolean };
  /** What the shops rows say, so the page can show "from your shops" next to an override. */
  channelDefaults: { etsy: boolean; shopify: boolean };
  mailbox: { connectedAddress: string | null; readInbox: boolean; sendFrom: string | null };
  printMix: { defaultProvider: PrintRoutingProvider; overrides: PrintRoutingOverride[] };
  replyConfidenceThreshold: number;
  autoSendTemplates: AutoSendTemplateKey[];
  /** 'Send my email replies automatically' (default on). */
  autoSendReplies: boolean;
  /** 'I approve each AI portrait before it goes out' (default on). */
  aiOwnerApproval: boolean;
};

export type AgentSettingsPatch = Partial<{
  flags: Partial<AgentFlagSet>;
  channels: { etsy?: boolean; shopify?: boolean };
  mailbox: { readInbox?: boolean; sendFrom?: string | null };
  printMix: { defaultProvider?: PrintRoutingProvider; overrides?: PrintRoutingOverride[] };
  replyConfidenceThreshold: number;
  autoSendTemplates: string[];
  autoSendReplies: boolean;
  aiOwnerApproval: boolean;
}>;

/** Shape a businesses row + its active shop platforms into the settings view. Pure. */
export function buildAgentSettings(
  biz: {
    id: string;
    agentIntakeEnabled: boolean;
    agentAssignEnabled: boolean;
    agentInboxEnabled: boolean;
    agentConfig: unknown;
    printRouting: unknown;
    gmailAddress: string | null;
  },
  shopPlatforms: string[],
): AgentSettings {
  const cfg = getAgentConfig(biz);
  const channelDefaults = { etsy: shopPlatforms.includes("etsy"), shopify: shopPlatforms.includes("shopify") };
  const rule = parsePrintRouting(biz.printRouting);
  const connected = biz.gmailAddress?.trim().toLowerCase() || null;
  return {
    businessId: biz.id,
    flags: { intake: biz.agentIntakeEnabled, assign: biz.agentAssignEnabled, inbox: biz.agentInboxEnabled },
    channelDefaults,
    channels: {
      etsy: cfg.channels.etsy ?? channelDefaults.etsy,
      shopify: cfg.channels.shopify ?? channelDefaults.shopify,
    },
    mailbox: {
      connectedAddress: connected,
      readInbox: cfg.mailbox.readInbox ?? true,
      // A pinned address only counts while it is still the connected account.
      sendFrom: cfg.mailbox.sendFrom && cfg.mailbox.sendFrom === connected ? cfg.mailbox.sendFrom : connected,
    },
    printMix: { defaultProvider: rule.default, overrides: rule.overrides },
    replyConfidenceThreshold: cfg.replyConfidenceThreshold,
    autoSendTemplates: cfg.autoSendTemplates as AutoSendTemplateKey[],
    autoSendReplies: cfg.autoSendReplies,
    aiOwnerApproval: cfg.aiOwnerApproval,
  };
}

/** Load the typed, defaulted config for one business (inside any transaction). */
export async function getBusinessAgentSettings(tx: Tx, businessId: string): Promise<AgentSettings | null> {
  const [biz] = await tx
    .select({
      id: businesses.id,
      agentIntakeEnabled: businesses.agentIntakeEnabled,
      agentAssignEnabled: businesses.agentAssignEnabled,
      agentInboxEnabled: businesses.agentInboxEnabled,
      agentConfig: businesses.agentConfig,
      printRouting: businesses.printRouting,
      gmailAddress: businesses.gmailAddress,
    })
    .from(businesses)
    .where(eq(businesses.id, businessId));
  if (!biz) return null;
  const shopRows = await tx
    .select({ platform: shops.platform, active: shops.active })
    .from(shops)
    .where(eq(shops.businessId, businessId));
  return buildAgentSettings(biz, shopRows.filter((r) => r.active).map((r) => r.platform));
}

/**
 * Validate and write a patch. Flags go to their columns, the print mix to
 * print_routing (so lib/print/routing.ts keeps working), everything else merges
 * into the agent_config jsonb. Unknown or out-of-range values are dropped or
 * clamped rather than stored.
 */
export async function saveAgentSettings(tx: Tx, businessId: string, patch: AgentSettingsPatch): Promise<AgentSettings | null> {
  const [biz] = await tx
    .select({ agentConfig: businesses.agentConfig, printRouting: businesses.printRouting })
    .from(businesses)
    .where(eq(businesses.id, businessId));
  if (!biz) return null;
  const set: Partial<typeof businesses.$inferInsert> = {};
  const cur = obj(biz.agentConfig);
  const next: Record<string, unknown> = { ...cur };
  if (patch.flags) {
    if (typeof patch.flags.intake === "boolean") set.agentIntakeEnabled = patch.flags.intake;
    if (typeof patch.flags.assign === "boolean") set.agentAssignEnabled = patch.flags.assign;
    if (typeof patch.flags.inbox === "boolean") {
      set.agentInboxEnabled = patch.flags.inbox;
      // Same stamp as the Customer Email switch: no backlog flood on turning it on.
      if (patch.flags.inbox) next.inboxEnabledAt = new Date().toISOString();
    }
  }
  if (patch.channels) next.channels = cleanChannels({ ...obj(cur.channels), ...patch.channels });
  if (patch.mailbox) next.mailbox = cleanMailbox({ ...obj(cur.mailbox), ...patch.mailbox });
  if (typeof patch.replyConfidenceThreshold === "number") {
    const t = num(patch.replyConfidenceThreshold, 0.5, 1, getAgentConfig(biz).replyConfidenceThreshold);
    next.replyConfidenceThreshold = Math.round(t * 100) / 100;
  }
  if (patch.autoSendTemplates) next.autoSendTemplates = cleanAutoSend(patch.autoSendTemplates);
  if (typeof patch.autoSendReplies === "boolean") next.autoSendReplies = patch.autoSendReplies;
  if (typeof patch.aiOwnerApproval === "boolean") next.aiOwnerApproval = patch.aiOwnerApproval;
  set.agentConfig = next as AgentConfigInput;
  if (patch.printMix) {
    const rule = parsePrintRouting(biz.printRouting);
    const provider = patch.printMix.defaultProvider ?? rule.default;
    // Re-run through parsePrintRouting so what is stored always round-trips through chooseProvider.
    const overrides = patch.printMix.overrides
      ? parsePrintRouting({ overrides: patch.printMix.overrides }).overrides.filter((o) => o.productType || o.size)
      : rule.overrides;
    set.printRouting = { default: provider === "gelato" ? "gelato" : DEFAULT_PRINT_PROVIDER, overrides };
  }
  await tx.update(businesses).set(set).where(eq(businesses.id, businessId));
  return getBusinessAgentSettings(tx, businessId);
}
