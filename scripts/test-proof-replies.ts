// Proof replies and the reminder guard (clean slating audit 2026-10-16, deck
// item 4): Emily Page 4199506964 and Megan Coakley 4197002875 approved their CPS
// proofs by email and AlphaOS never knew (the inbox switch was off), and Shelby
// Leachet 4199624202 was asked to approve 45 min after asking for changes.
// The pure decision rule first, then lib/agent/proof-replies.ts, the reminders
// sweep and the send gate against a throwaway business of their own
// ("Proof Replies Test <stamp>", inbox switch OFF like CPS), deleted at the end.
// Classifications are stored on the seeded messages, so no model is called.
// Never run against production.
import "./load-env";

// No model in this test: an unclassified reply must simply be left alone.
process.env.ANTHROPIC_API_KEY = "";
process.env.ALPHA_HOOK_URL = "";

import { randomUUID } from "node:crypto";

import { Pool, neonConfig } from "@neondatabase/serverless";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-serverless";
import ws from "ws";

import { runAgentTick } from "../lib/agent/autopilot";
import { decideFromReplies, runProofRepliesPass } from "../lib/agent/proof-replies";
import { withSystemContext } from "../lib/db";
import * as schema from "../lib/db/schema";
import { activityLog, alphaEvents, businesses, customers, messages, orderItems, orders, proofs, reminderFires, shops } from "../lib/db/schema";
import { sendMessage } from "../lib/email/dispatch";
import { runRemindersSweep } from "../lib/reminders/sweep";
import { generateProofToken } from "../lib/proofs/tokens";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
};

const HOUR = 3_600_000;
const now = new Date();
const ago = (hours: number) => new Date(now.getTime() - hours * HOUR);

function pureTests() {
  const c = (intent: "approval" | "revision_request" | "question" | "unclear", confidence: number) => ({ intent, confidence, strippedText: "" });
  check("decide: a clear approval approves", decideFromReplies([{ id: "a", c: c("approval", 0.97) }], 0.85)?.decision === "approved");
  check("decide: below the bar, nothing", decideFromReplies([{ id: "a", c: c("approval", 0.6) }], 0.85) === null);
  check("decide: unclassified, nothing", decideFromReplies([{ id: "a", c: null }], 0.85) === null);
  check("decide: a question, nothing", decideFromReplies([{ id: "a", c: c("question", 0.99) }], 0.85) === null);
  const both = decideFromReplies([{ id: "a", c: c("approval", 0.97) }, { id: "r", c: c("revision_request", 0.9) }], 0.85);
  check("decide: a change request wins over an approval, whatever the order", both?.decision === "revision" && both.messageId === "r");
  const both2 = decideFromReplies([{ id: "r", c: c("revision_request", 0.9) }, { id: "a", c: c("approval", 0.97) }], 0.85);
  check("decide: ... also when the approval came last", both2?.decision === "revision");
  const twoApprovals = decideFromReplies([{ id: "a1", c: c("approval", 0.9) }, { id: "a2", c: c("approval", 0.95) }], 0.85);
  check("decide: the latest clear approval is the one applied", twoApprovals?.messageId === "a2");
}

const stamp = Date.now();
const ids = { biz: randomUUID(), shop: randomUUID(), cust: randomUUID() };

async function setup() {
  await withSystemContext(async (tx) => {
    // Inbox switch OFF (the default), like CPS on 2026-10-16.
    await tx.insert(businesses).values({ id: ids.biz, name: `Proof Replies Test ${stamp}`, slug: `proof-replies-test-${stamp}` });
    await tx.insert(shops).values({ id: ids.shop, businessId: ids.biz, platform: "shopify", name: "Pr Shop", externalShopId: `pr-${stamp}`, credentials: {} });
    await tx.insert(customers).values({ id: ids.cust, businessId: ids.biz, email: `pr-customer-${stamp}@example.test`, firstName: "Shelby" });
  });
}

let n = 0;
async function order(o: { proofHoursAgo: number; physical?: boolean; status?: typeof orders.$inferInsert.status }) {
  n++;
  return withSystemContext(async (tx) => {
    const [row] = await tx
      .insert(orders)
      .values({
        businessId: ids.biz,
        shopId: ids.shop,
        customerId: ids.cust,
        platformOrderId: `pr-${stamp}-${n}`,
        platformOrderName: `PR${n}`,
        status: o.status ?? "awaiting_approval",
        source: "manual",
        uploadToken: randomUUID(),
        createdAt: ago(o.proofHoursAgo + 48),
        // Placed after the legacy cutoff (lib/agent/scope.ts, 12 Oct 2026), so the
        // hands-off rule for untouched legacy orders never silences these as the
        // calendar moves on.
        placedAt: new Date(Math.max(ago(o.proofHoursAgo + 48).getTime(), Date.parse("2026-10-12T12:00:00Z"))),
      })
      .returning({ id: orders.id });
    await tx.insert(orderItems).values({
      businessId: ids.biz,
      orderId: row.id,
      title: "Custom portrait",
      figureCount: 1,
      figureCountSource: "manual",
      productType: o.physical ? "physical" : "digital",
    });
    const at = ago(o.proofHoursAgo);
    const [p] = await tx.insert(proofs).values({ businessId: ids.biz, orderId: row.id, token: generateProofToken(), sentAt: at, createdAt: at }).returning({ id: proofs.id });
    return { id: row.id, proofId: p.id };
  });
}

async function inbound(
  orderId: string,
  body: string,
  hoursAgo: number,
  cls: { intent: string; confidence: number } | null,
  channel: "email" | "etsy" = "email",
) {
  return withSystemContext(async (tx) => {
    const [m] = await tx
      .insert(messages)
      .values({
        businessId: ids.biz,
        orderId,
        customerId: ids.cust,
        direction: "inbound",
        channel,
        status: "received",
        subject: "Re: your proof",
        address: `pr-customer-${stamp}@example.test`,
        body,
        createdAt: ago(hoursAgo),
        metadata: {
          ...(channel === "etsy" ? { kind: "message" } : {}),
          ...(cls ? { replyClassification: { model: "test", intent: cls.intent, confidence: cls.confidence, rationale: "seeded", happy: false, strippedText: body, classifiedAt: ago(hoursAgo).toISOString() } } : {}),
        },
      })
      .returning({ id: messages.id });
    return m.id;
  });
}

async function reminder(orderId: string, status: "draft" | "queued") {
  return withSystemContext(async (tx) => {
    const [m] = await tx
      .insert(messages)
      .values({
        businessId: ids.biz,
        orderId,
        customerId: ids.cust,
        direction: "outbound",
        channel: "email",
        status,
        templateKey: "proof_reminder",
        subject: "A reminder about your proof",
        address: `pr-customer-${stamp}@example.test`,
        body: "Please approve your proof.",
        dedupeKey: `test:${randomUUID()}`,
      })
      .returning({ id: messages.id });
    return m.id;
  });
}

const statusOf = (orderId: string) =>
  withSystemContext(async (tx) => (await tx.select({ s: orders.status }).from(orders).where(eq(orders.id, orderId)))[0]?.s);
const msgRow = (id: string) =>
  withSystemContext(async (tx) => (await tx.select({ status: messages.status, archivedAt: messages.archivedAt, metadata: messages.metadata }).from(messages).where(eq(messages.id, id)))[0]);
const actions = (orderId: string, action: string) =>
  withSystemContext((tx) => tx.select({ metadata: activityLog.metadata }).from(activityLog).where(and(eq(activityLog.orderId, orderId), eq(activityLog.action, action))));
const remindersFor = (orderId: string) =>
  withSystemContext((tx) =>
    tx.select({ id: messages.id }).from(messages).where(and(eq(messages.orderId, orderId), eq(messages.templateKey, "proof_reminder"), sql`${messages.dedupeKey} like 'stage:%'`)),
  );

async function dbTests() {
  // Megan Six: an approval classified at 97% and never applied.
  const approve = await order({ proofHoursAgo: 30 });
  const approveMsg = await inbound(approve.id, "Love it, approved!", 5, { intent: "approval", confidence: 0.97 });
  const staleReminder = await reminder(approve.id, "draft");
  // Shelby: "love it" then changes: the change request wins.
  const change = await order({ proofHoursAgo: 80 });
  await inbound(change.id, "Love it!", 10, { intent: "approval", confidence: 0.9 });
  const changeMsg = await inbound(change.id, "Actually could you make her hair darker?", 6, { intent: "revision_request", confidence: 0.9 });
  // Below the bar and a question: left exactly as they are.
  const unsure = await order({ proofHoursAgo: 30 });
  await inbound(unsure.id, "hmm ok", 3, { intent: "approval", confidence: 0.5 });
  const question = await order({ proofHoursAgo: 30 });
  const questionMsg = await inbound(question.id, "Can I get it framed?", 3, { intent: "question", confidence: 0.95 });
  // Emily Page's shape, no model to read it: untouched.
  const unread = await order({ proofHoursAgo: 30 });
  await inbound(unread.id, "absolutely perfect ... I love it!!", 3, null);
  // An approval written BEFORE the latest proof went out is not about this proof.
  const old = await order({ proofHoursAgo: 4 });
  await inbound(old.id, "approved", 10, { intent: "approval", confidence: 0.99 });
  // An Etsy conversation message approves too.
  const etsy = await order({ proofHoursAgo: 30 });
  await inbound(etsy.id, "Perfect, go ahead", 2, { intent: "approval", confidence: 0.95 }, "etsy");

  const dry = await runProofRepliesPass({ id: ids.biz }, { dryRun: true });
  check("dry run: counts the two approvals and the change request", dry.approvalsApplied === 2 && dry.revisionsApplied === 1, JSON.stringify(dry));
  check("dry run: nothing changed", (await statusOf(approve.id)) === "awaiting_approval" && (await statusOf(change.id)) === "awaiting_approval");

  const offRun = await runProofRepliesPass({ id: ids.biz, agentConfig: { proofReplyDecisions: false } });
  check("switch off (proofReplyDecisions false): nothing looked at", offRun.ordersChecked === 0 && offRun.approvalsApplied === 0);

  // Through the real tick: the inbox switch is off, the pass still runs.
  const tick = await runAgentTick({ businessId: ids.biz, now });
  const pr = tick.businesses[0]?.proofReplies;
  check("tick (inbox off): runs the proof-replies pass", pr?.approvalsApplied === 2 && pr.revisionsApplied === 1, JSON.stringify(pr));
  check("approval by email approves the order (Megan Six)", (await statusOf(approve.id)) === "approved");
  check("approval by Etsy message approves too", (await statusOf(etsy.id)) === "approved");
  check("change request sends it back to design (Shelby)", (await statusOf(change.id)) === "in_design");
  const rev = await actions(change.id, "order.in_design");
  check(
    "change request: her words are the revision reason",
    rev.some((r) => (r.metadata as { revisionReason?: string })?.revisionReason === "Actually could you make her hair darker?"),
    JSON.stringify(rev),
  );
  check("below the bar: left alone", (await statusOf(unsure.id)) === "awaiting_approval");
  check("question: left alone, not marked handled", (await statusOf(question.id)) === "awaiting_approval" && (await actions(question.id, "agent.reply_applied")).length === 0);
  check("unclassified with no model: left alone", (await statusOf(unread.id)) === "awaiting_approval");
  check("an approval older than the latest proof is not applied", (await statusOf(old.id)) === "awaiting_approval");
  const applied = await actions(approve.id, "agent.reply_applied");
  check(
    "stamped agent.reply_applied (the inbox pass never handles it twice)",
    applied.length === 1 && (applied[0].metadata as { messageId?: string; via?: string }).messageId === approveMsg,
  );
  const covered = await actions(change.id, "agent.reply_applied");
  check("both of Shelby's messages are covered by the one decision", covered.length === 2 && covered.every((r) => (r.metadata as { decidedBy?: string }).decidedBy === changeMsg));
  const r1 = await msgRow(staleReminder);
  check("the waiting proof reminder is withdrawn (archived draft)", !!r1?.archivedAt && r1.status === "draft" && !!(r1.metadata as { withdrawn?: unknown })?.withdrawn);
  check("withdrawal is on the order's timeline", (await actions(approve.id, "email.proof_reminder_withdrawn")).length === 1);

  const again = await runProofRepliesPass({ id: ids.biz });
  check("second pass: no-op", again.approvalsApplied === 0 && again.revisionsApplied === 0, JSON.stringify(again));
  check("question classification stays for the VA card", !!(await msgRow(questionMsg))?.metadata);

  // --- reminders sweep: a reply is not silence -------------------------------
  // Shelby's exact shape: proof 3+ days out, she wrote 45 min ago, no decision
  // yet. Print and ship: a digital proof is never reminded at all (2026-10-31).
  const shelby = await order({ proofHoursAgo: 80, physical: true });
  await inbound(shelby.id, "Could you change the background?", 0.75, null);
  // Physical, proof 8 days out, she asked a question on day 2.
  const asked = await order({ proofHoursAgo: 24 * 8, physical: true });
  await inbound(asked.id, "When will it ship?", 24 * 6, { intent: "question", confidence: 0.95 });
  // Truly silent print and ship, 4 days: still reminded (the control).
  const silent = await order({ proofHoursAgo: 96, physical: true });

  const sweep = await runRemindersSweep({ businessIds: [ids.biz], now });
  check("sweep: no reminder after the buyer wrote (Shelby)", (await remindersFor(shelby.id)).length === 0);
  check("sweep: a reply is not silence, no reminder and still awaiting approval", (await statusOf(asked.id)) === "awaiting_approval" && (await remindersFor(asked.id)).length === 0);
  const silentAlerts = await withSystemContext((tx) => tx.select({ id: alphaEvents.id }).from(alphaEvents).where(eq(alphaEvents.orderId, asked.id)));
  check("sweep: no 'customer silent' alert after a reply", silentAlerts.length === 0);
  check("sweep: a truly silent buyer is still reminded", (await remindersFor(silent.id)).length === 1);
  check("sweep: counts the proofs left alone", sweep.buyerReplied >= 2, JSON.stringify(sweep));
  const claims = await withSystemContext((tx) => tx.select({ id: reminderFires.id }).from(reminderFires).where(eq(reminderFires.orderId, shelby.id)));
  check("sweep: nothing claimed for her proof", claims.length === 0);

  // --- the send gate: queued before she answered, she answered, then the flush.
  const late = await order({ proofHoursAgo: 80, physical: true });
  const queued = await reminder(late.id, "queued");
  await inbound(late.id, "I want changes please", 0.2, null);
  const res = await sendMessage(queued);
  check("send: a queued reminder overtaken by her reply is withdrawn, not sent", !res.ok && "withdrawn" in res && res.withdrawn === true, JSON.stringify(res));
  const q1 = await msgRow(queued);
  check("send: withdrawn = archived draft, out of the queued flush", q1?.status === "draft" && !!q1.archivedAt);
  const tap = await sendMessage(queued, { approvedById: undefined });
  check("send: a second try stays withdrawn", !tap.ok);
  // Order moved on: the old gate, same withdrawal.
  const moved = await order({ proofHoursAgo: 80, status: "in_design" });
  const queued2 = await reminder(moved.id, "queued");
  const res2 = await sendMessage(queued2);
  check("send: order no longer awaiting approval = withdrawn", !res2.ok && "withdrawn" in res2 && res2.withdrawn === true);
}

async function cleanup() {
  neonConfig.webSocketConstructor = ws;
  const pool = new Pool({ connectionString: process.env.DIRECT_URL ?? process.env.DATABASE_URL! });
  const ownerDb = drizzle(pool, { schema });
  try {
    const res = await ownerDb.execute(sql`
      select c.table_name from information_schema.columns c
      join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
      where c.table_schema = 'public' and c.column_name = 'business_id' and c.table_name <> 'businesses'`);
    let left = (res.rows as { table_name: string }[]).map((r) => r.table_name);
    for (let pass = 0; pass < 8 && left.length; pass++) {
      const blocked: string[] = [];
      for (const t of left) {
        try {
          await ownerDb.execute(sql`delete from ${sql.identifier(t)} where business_id = ${ids.biz}`);
        } catch {
          blocked.push(t);
        }
      }
      left = blocked;
    }
    if (left.length) console.log(`cleanup: could not clear ${left.join(", ")}`);
    await ownerDb.delete(businesses).where(eq(businesses.id, ids.biz));
  } finally {
    await pool.end();
  }
}

async function main() {
  pureTests();
  await setup();
  try {
    await dbTests();
  } finally {
    await cleanup();
  }
  console.log(failed ? `\n${failed} check(s) failed` : "\nall proof-replies checks passed");
  process.exit(failed ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await cleanup().catch(() => undefined);
  process.exit(1);
});
