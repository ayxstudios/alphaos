// Email dedupe against the DEMO database (Paws and Pencils): re-entering
// in_design through internal moves (reassign twice, AI claim/re-list, a status
// reset) queues ONE stage email; outbox retries never resend a sent message; a
// genuine new event (new tracking number) still mails. Synthetic orders
// (marker "dedupetest-"), removed at the end. Never run against staging or prod.
import "./load-env";

import { randomUUID } from "node:crypto";

if (!process.env.ANTHROPIC_API_KEY?.startsWith("mock_")) process.env.ANTHROPIC_API_KEY = "mock_sk-ant-dedupetest";

import { and, eq, inArray, sql } from "drizzle-orm";

import { claimJob, getAgentDesignerId, listPendingJobs, reassignOrder, setStyleAiDesigner } from "../lib/agent/ai-designer";
import { runOutboxPass } from "../lib/agent/outbox";
import { withSystemContext, SYSTEM_ACTOR_ID } from "../lib/db";
import { businesses, customers, designerBusinesses, messages, orderItems, orders, shops, styles, users } from "../lib/db/schema";
import { queueStageEmail, sendMessage } from "../lib/email/dispatch";
import { installMockTransport } from "../lib/mock/transport";
import { runAutoAssign } from "../lib/orders/assign";
import { runTransition } from "../lib/orders/transitions";

installMockTransport?.();

const BUSINESS_NAME = "Paws and Pencils";
const MARK = "dedupetest-";
const STYLE = "Disney Pet";
const SYS = { id: SYSTEM_ACTOR_ID, role: "system" as const };

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
};
const q = <T>(fn: (tx: Parameters<Parameters<typeof withSystemContext>[0]>[0]) => Promise<T>) => withSystemContext(fn);

async function main() {
  const [biz] = await q((tx) => tx.select({ id: businesses.id, agentConfig: businesses.agentConfig }).from(businesses).where(eq(businesses.name, BUSINESS_NAME)));
  if (!biz) throw new Error("demo business missing");
  const businessId = biz.id;
  const [shop] = await q((tx) => tx.select({ id: shops.id }).from(shops).where(eq(shops.businessId, businessId)).limit(1));
  const [human] = await q((tx) =>
    tx
      .select({ id: users.id })
      .from(users)
      .innerJoin(designerBusinesses, and(eq(designerBusinesses.userId, users.id), eq(designerBusinesses.businessId, businessId)))
      .where(and(eq(users.role, "designer"), sql`${users.email} not like 'ai-studio+%'`))
      .limit(1),
  );
  const agentId = await q((tx) => getAgentDesignerId(tx, businessId));
  if (!agentId || !human || !shop) throw new Error("demo data missing");
  await q(async (tx) => {
    const [s] = await tx.select({ id: styles.id }).from(styles).where(and(eq(styles.businessId, businessId), sql`lower(${styles.name}) = lower(${STYLE})`));
    if (!s) await tx.insert(styles).values({ businessId, name: STYLE, titleMatches: ["Disney", "Pixar"] });
  });
  const [styleBefore] = await q((tx) => tx.select({ on: styles.aiDesignerEnabled, fw: styles.aiFramework }).from(styles).where(and(eq(styles.businessId, businessId), sql`lower(${styles.name}) = lower(${STYLE})`)));

  const created: string[] = [];
  const stamp = Date.now();
  const mails = (orderId: string, key: string) =>
    q((tx) => tx.select({ id: messages.id, status: messages.status }).from(messages).where(and(eq(messages.orderId, orderId), eq(messages.templateKey, key as never))));

  try {
    await q((tx) => setStyleAiDesigner(tx, { businessId, styleName: STYLE, enabled: true, framework: "pixart-disney-pet" }));
    const [cust] = await q((tx) => tx.insert(customers).values({ businessId, email: `${MARK}${stamp}@example.test`, firstName: "Dedupe", lastName: "Test" }).returning({ id: customers.id }));
    const name = `${MARK}${stamp}`;
    const id = await q(async (tx) => {
      const [o] = await tx
        .insert(orders)
        .values({ businessId, shopId: shop.id, customerId: cust.id, platformOrderId: name, platformOrderName: name, status: "ready_to_assign", source: "manual", uploadToken: randomUUID() })
        .returning({ id: orders.id });
      created.push(o.id);
      await tx.insert(orderItems).values({ businessId, orderId: o.id, title: `${STYLE} portrait`, style: STYLE, figureCount: 1, figureCountSource: "manual", productType: "digital" });
      return o.id;
    });

    // Assign to the agent, bounce between designers twice (still ready_to_assign).
    await q((tx) => runAutoAssign(tx, { orderId: id, businessId, assignedBy: null }));
    await reassignOrder(id, human.id, null);
    await reassignOrder(id, agentId, null);
    await reassignOrder(id, human.id, null);
    await reassignOrder(id, agentId, null);
    check("reassigning while ready_to_assign mails nothing", (await mails(id, "in_design")).length === 0);

    // AI claim enters in_design: the first (and only legitimate) mail.
    await listPendingJobs({ businessId });
    await claimJob(id);
    check("first entry to in_design queues exactly one mail", (await mails(id, "in_design")).length === 1);

    // Re-list / reassign twice while in design, then a status reset that re-enters the same edge (the demo bug).
    await reassignOrder(id, human.id, null);
    await reassignOrder(id, agentId, null);
    await listPendingJobs({ businessId });
    for (let i = 0; i < 3; i++) {
      await q((tx) => tx.update(orders).set({ status: "ready_to_assign" }).where(eq(orders.id, id)));
      await q((tx) => runTransition(tx, SYS, { orderId: id, to: "in_design", expectedFrom: "ready_to_assign", metadata: { via: "dedupetest" } }));
    }
    check("reassign x2 + re-list + 3 re-entries still one in_design mail", (await mails(id, "in_design")).length === 1);

    // A direct second insert with the same moment is dropped by the db index.
    const order = await q((tx) => tx.select({ id: orders.id, businessId: orders.businessId, customerId: orders.customerId, platformOrderId: orders.platformOrderId, platformOrderName: orders.platformOrderName }).from(orders).where(eq(orders.id, id)).then((r) => r[0]));
    const again = await q((tx) => queueStageEmail(tx, order, "in_design"));
    check("queueStageEmail for an already-mailed stage returns null", again === null);

    // Outbox retry pass on a message that already reached 'sent' must not touch or resend it.
    const [m] = await mails(id, "in_design");
    await q((tx) => tx.update(messages).set({ status: "sent", sentAt: new Date("2026-01-01T00:00:00Z"), error: "old error" }).where(eq(messages.id, m.id)));
    await runOutboxPass({ id: businessId, name: BUSINESS_NAME, agentConfig: biz.agentConfig });
    await runOutboxPass({ id: businessId, name: BUSINESS_NAME, agentConfig: biz.agentConfig });
    const [after] = await q((tx) => tx.select({ status: messages.status, sentAt: messages.sentAt }).from(messages).where(eq(messages.id, m.id)));
    check("outbox passes leave a sent message sent, untouched", after.status === "sent" && after.sentAt?.toISOString() === "2026-01-01T00:00:00.000Z");
    const res = await sendMessage(m.id);
    check("sendMessage on a sent message is a no-op ok", res.ok === true);
    check("still exactly one in_design mail after the passes", (await mails(id, "in_design")).length === 1);

    // A message marked sent by hand is never resent either, even when it is 'failed'.
    await q((tx) => tx.update(messages).set({ status: "failed", manualSentAt: new Date() }).where(eq(messages.id, m.id)));
    const hand = await sendMessage(m.id);
    check("manually-sent message is never resent", hand.ok === true);

    // The send claim: a row another pass holds is not sent a second time.
    await q((tx) => tx.update(messages).set({ status: "queued", manualSentAt: null, sendClaimedAt: new Date() }).where(eq(messages.id, m.id)));
    const busy = await sendMessage(m.id);
    check("a send already in flight is not started twice", busy.ok === false && busy.retryable === true);
    await q((tx) => tx.update(messages).set({ status: "sent", sendClaimedAt: null }).where(eq(messages.id, m.id)));

    // Genuine new events still send: shipped with a new tracking number is a new mail; the same one is not.
    const s1 = await q((tx) => queueStageEmail(tx, order, "shipped", { tracking_number: "TRK1" }));
    const s1b = await q((tx) => queueStageEmail(tx, order, "shipped", { tracking_number: "TRK1" }));
    const s2 = await q((tx) => queueStageEmail(tx, order, "shipped", { tracking_number: "TRK2" }));
    check("shipped: new tracking mails, same tracking does not", !!s1 && s1b === null && !!s2);
    const r1 = await q((tx) => queueStageEmail(tx, order, "proof_reminder", { proof_link: "https://x.test/p/a" }));
    const r1b = await q((tx) => queueStageEmail(tx, order, "proof_reminder", { proof_link: "https://x.test/p/a" }));
    const r2 = await q((tx) => queueStageEmail(tx, order, "proof_reminder", { proof_link: "https://x.test/p/b" }));
    check("proof reminder: new proof mails, same proof does not", !!r1 && r1b === null && !!r2);
    // The second deliberate reminder for one proof is its own moment (agent max 2 per proof).
    const r1r2 = await q((tx) => queueStageEmail(tx, order, "proof_reminder", { proof_link: "https://x.test/p/a" }, { repeat: 2 }));
    const r1r2b = await q((tx) => queueStageEmail(tx, order, "proof_reminder", { proof_link: "https://x.test/p/a" }, { repeat: 2 }));
    check("proof reminder: second reminder for one proof mails once", !!r1r2 && r1r2b === null);
  } finally {
    await q(async (tx) => {
      if (created.length) {
        await tx.delete(messages).where(inArray(messages.orderId, created));
        await tx.delete(orders).where(inArray(orders.id, created));
      }
      await tx.delete(customers).where(sql`${customers.email} like ${MARK + "%"}`);
      if (styleBefore) await tx.update(styles).set({ aiDesignerEnabled: styleBefore.on, aiFramework: styleBefore.fw }).where(and(eq(styles.businessId, businessId), sql`lower(${styles.name}) = lower(${STYLE})`));
    });
  }
  console.log(failed ? `\n${failed} FAILED` : "\nall passed");
  process.exit(failed ? 1 : 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
