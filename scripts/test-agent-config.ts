// Per-business agent config (Settings > Agent) against the DEMO database
// (Northlight Portraits): defaults, validated round-trip, print_routing staying
// compatible with chooseProvider, template auto-send wiring, and the nav rule
// for agent flags on/off. Restores the business's flags, agent_config and
// print_routing exactly. Never run against staging or production.
import "./load-env";

import { eq } from "drizzle-orm";

import { AGENT_CONFIG_DEFAULTS, getAgentConfig, getBusinessAgentSettings, saveAgentSettings } from "../lib/agent/config";
import { adminExtraKeys, isAgentMode, primaryNavKeys, tabNavKeys } from "../lib/agent/nav";
import { withSystemContext } from "../lib/db";
import { businesses } from "../lib/db/schema";
import { withSignature } from "../lib/email/dispatch";
import { chooseProvider } from "../lib/print/routing";

const BUSINESS_NAME = "Northlight Portraits";
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
};

async function main() {
  // --- pure pieces ---------------------------------------------------------
  const d = getAgentConfig(null);
  check("defaults: threshold 0.85, no auto-send, no overrides", d.replyConfidenceThreshold === 0.85 && d.autoSendTemplates.length === 0 && !d.channels.etsy);
  const junk = getAgentConfig({ agentConfig: { replyConfidenceThreshold: 7, autoSendTemplates: ["shipped", "photo_request", 4], channels: { etsy: "yes" }, mailbox: { sendFrom: "nope" } } });
  check("junk is dropped or defaulted", junk.replyConfidenceThreshold === 0.85 && junk.autoSendTemplates.join() === "shipped" && junk.channels.etsy === undefined && junk.mailbox.sendFrom === undefined);
  check("agent mode: all off = false", !isAgentMode({}) && !isAgentMode({ agentIntakeEnabled: false, agentAssignEnabled: false, agentInboxEnabled: false }));
  check("agent mode: any one on = true", isAgentMode({ agentInboxEnabled: true }) && isAgentMode({ agentAssignEnabled: true }));
  check("safety defaults: no cutoff, 30 auto sends/hour, no print drafts", d.agentFrom === null && d.maxAutoSendsPerHour === 30 && d.printDrafts === false);
  const safe = getAgentConfig({ agentConfig: { agentFrom: "2026-09-30T14:00:00Z", maxAutoSendsPerHour: 5000, printDrafts: "yes" } });
  check("safety keys validated", safe.agentFrom === "2026-09-30T14:00:00Z" && safe.maxAutoSendsPerHour === 30 && safe.printDrafts === false);
  check("junk cutoff dropped", getAgentConfig({ agentConfig: { agentFrom: "soon" } }).agentFrom === null);
  const sig = getAgentConfig({ agentConfig: { emailSignature: { text: "Shop | shop.co", html: "<b>Shop</b> | shop.co" } } }).emailSignature;
  check("signature kept when well formed", sig?.text === "Shop | shop.co" && d.emailSignature === null);
  check("junk signature dropped", getAgentConfig({ agentConfig: { emailSignature: { text: "x" } } }).emailSignature === null);
  const signed = withSignature("Hi Sam,\n\nThanks!", sig);
  check("signature appended to text and html", signed.text.endsWith("\n\nShop | shop.co") && !!signed.html?.includes("<b>Shop</b>") && !!signed.html?.includes("<p>Hi Sam,</p>"));
  check("no signature = body untouched", withSignature("Hi", null).text === "Hi" && withSignature("Hi", null).html === undefined);
  const off = primaryNavKeys("va", false);
  const on = primaryNavKeys("va", true);
  check("VA flags off = Yousif's VA menu (qc, no today/day/overview/exceptions)", off.join() === "home,qc,messages,boards,print,orders");
  check("VA flags on = same menu plus exceptions", on.join() === "home,qc,exceptions,messages,boards,print,orders");
  const aOn = primaryNavKeys("admin", true);
  const aOff = primaryNavKeys("admin", false);
  check("admin on/off follows the same rule, keeps settings", !aOn.includes("today") && aOn.includes("day") && aOff.includes("today") && aOn.includes("settings") && aOff.includes("settings"));
  check("admin flags off: overview+exceptions in the extra group", adminExtraKeys(false).join() === "overview,exceptions" && adminExtraKeys(true).length === 0);
  check("phone tabs: Day replaces Today only in agent mode", tabNavKeys(true).includes("day") && !tabNavKeys(true).includes("today") && tabNavKeys(false).includes("today") && !tabNavKeys(false).includes("day"));
  check("designer nav untouched", primaryNavKeys("designer", true).join() === primaryNavKeys("designer", false).join());

  // --- database round trip -------------------------------------------------
  const before = await withSystemContext(async (tx) => {
    const [b] = await tx.select().from(businesses).where(eq(businesses.name, BUSINESS_NAME));
    return b;
  });
  if (!before) throw new Error(`demo business "${BUSINESS_NAME}" not found`);
  console.log("before:", JSON.stringify({ intake: before.agentIntakeEnabled, assign: before.agentAssignEnabled, inbox: before.agentInboxEnabled, agentConfig: before.agentConfig, printRouting: before.printRouting }));

  try {
    await withSystemContext((tx) =>
      tx.update(businesses).set({ agentIntakeEnabled: false, agentAssignEnabled: false, agentInboxEnabled: false, agentConfig: {}, printRouting: {} }).where(eq(businesses.id, before.id)),
    );
    const s0 = await withSystemContext((tx) => getBusinessAgentSettings(tx, before.id));
    check("settings default: lumaprints, no overrides, drafts only", s0?.printMix.defaultProvider === "lumaprints" && s0.printMix.overrides.length === 0 && s0.autoSendTemplates.length === 0);
    check("channels derived from shops rows", s0 !== null && typeof s0.channels.etsy === "boolean" && s0.channels.etsy === s0.channelDefaults.etsy && s0.channels.shopify === s0.channelDefaults.shopify);
    check("mailbox defaults to reading the connected address", s0?.mailbox.readInbox === true && s0.mailbox.sendFrom === s0.mailbox.connectedAddress);
    check("threshold default matches AGENT_CONFIG_DEFAULTS", s0?.replyConfidenceThreshold === AGENT_CONFIG_DEFAULTS.replyConfidenceThreshold);

    const saved = await withSystemContext((tx) =>
      saveAgentSettings(tx, before.id, {
        flags: { intake: true, inbox: true },
        channels: { shopify: false },
        mailbox: { readInbox: false },
        printMix: { defaultProvider: "lumaprints", overrides: [{ productType: "canvas", size: "16x20", provider: "gelato" }, { provider: "gelato" }] },
        replyConfidenceThreshold: 0.9,
        autoSendTemplates: ["shipped", "bogus"],
      }),
    );
    check("round trip: flags", saved?.flags.intake === true && saved.flags.inbox === true && saved.flags.assign === false);
    check("round trip: channel override, mailbox, threshold", saved?.channels.shopify === false && saved.mailbox.readInbox === false && saved.replyConfidenceThreshold === 0.9);
    check("round trip: unknown template dropped", saved?.autoSendTemplates.join() === "shipped");
    check("round trip: empty override dropped", saved?.printMix.overrides.length === 1);
    const row = await withSystemContext(async (tx) => (await tx.select().from(businesses).where(eq(businesses.id, before.id)))[0]!);
    check("inbox on stamps inboxEnabledAt", typeof getAgentConfig(row).inboxEnabledAt === "string");
    check("print_routing written in the routing.ts shape", (row.printRouting as { default?: string }).default === "lumaprints");
    check("chooseProvider: canvas 16x20 override to gelato", chooseProvider(row, { productType: "canvas", size: "16 x 20" }).provider === "gelato");
    check("chooseProvider: other items stay lumaprints", chooseProvider(row, { productType: "print", size: "8x10" }).provider === "lumaprints");
    const clamp = await withSystemContext((tx) => saveAgentSettings(tx, before.id, { replyConfidenceThreshold: 12 }));
    check("out-of-range threshold is not stored", clamp?.replyConfidenceThreshold === 0.9);
    const flip = await withSystemContext((tx) => saveAgentSettings(tx, before.id, { printMix: { defaultProvider: "gelato" } }));
    check("default provider switch keeps overrides", flip?.printMix.defaultProvider === "gelato" && flip.printMix.overrides.length === 1);
  } finally {
    await withSystemContext((tx) =>
      tx
        .update(businesses)
        .set({
          agentIntakeEnabled: before.agentIntakeEnabled,
          agentAssignEnabled: before.agentAssignEnabled,
          agentInboxEnabled: before.agentInboxEnabled,
          agentConfig: before.agentConfig,
          printRouting: before.printRouting,
        })
        .where(eq(businesses.id, before.id)),
    );
    const after = await withSystemContext(async (tx) => (await tx.select().from(businesses).where(eq(businesses.id, before.id)))[0]!);
    check(
      "restored flags, agent_config and print_routing",
      after.agentIntakeEnabled === before.agentIntakeEnabled &&
        after.agentAssignEnabled === before.agentAssignEnabled &&
        after.agentInboxEnabled === before.agentInboxEnabled &&
        JSON.stringify(after.agentConfig) === JSON.stringify(before.agentConfig) &&
        JSON.stringify(after.printRouting) === JSON.stringify(before.printRouting),
    );
  }
  console.log(failed ? `\n${failed} FAILED` : "\nALL PASS");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
