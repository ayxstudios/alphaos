/**
 * End-to-end pipeline walk on MOCK integrations (2026-09-08).
 *
 * Runs the same code the cron routes and the UI run, against the seeded
 * database, with every external API answered by lib/mock/transport.ts
 * (Shopify, Etsy, Gmail, Anthropic, Gelato, Luma Prints). Nothing leaves the
 * machine. Each step asserts what the pipeline must have produced and the
 * run ends with one table.
 *
 *   1. Shop sync         Shopify orders + Etsy receipts land as orders
 *   2. Mailbox poll      Etsy sale / message emails attach to orders
 *   3. Email flush       queued photo requests and stage emails "send"
 *   4. Designer lane     assign -> in_design -> submit -> QC pass
 *   5. Customer window   proof email out, customer reply in, classified, approved
 *   6. Print             sent to Gelato -> reconcile finds it shipped -> tracking, fulfilment, shipped email
 *   7. Sweeps            SLA notifications, reminders, designer lane -> alpha_events
 *   8. Daily health      narrative written by the (mock) model
 *
 * Usage: npm run db:seed && npm run mock:pipeline
 */
import "./load-env";
process.env.MOCK_INTEGRATIONS = "1";
process.env.PRINT_PROVIDER_MOCK ||= "1";
process.env.ANTHROPIC_API_KEY ||= "mock_sk-ant-api03-demo";

import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { installMockTransport, mockState } from "../lib/mock/transport";
import { withSystemContext, type RequestUser } from "../lib/db";
import {
  activityLog,
  alphaEvents,
  assets,
  assignments,
  businesses,
  messages,
  orderItems,
  orders,
  printJobs,
  proofs,
  users,
} from "../lib/db/schema";
import { syncAllShops } from "../lib/integrations/scheduler";
import { pollMailbox, pollMailboxesScheduled } from "../lib/integrations/gmail/inbound";
import { flushQueued } from "../lib/email/dispatch";
import { runAutoAssign } from "../lib/orders/assign";
import { runTransition, transitionAsSystem } from "../lib/orders/transitions";
import { approveProof } from "../lib/proofs/decide";
import { recordManualPrintSignal } from "../lib/print/manual";
import { reconcileAllBusinesses } from "../lib/print/reconcile";
import { runNotificationSweep } from "../lib/notifications/sla-sweep";
import { runRemindersSweep } from "../lib/reminders/sweep";
import { runDesignerLaneSweep } from "../lib/notifications/designer-sweep";
import { deliverDailyHealthReports } from "../lib/health/delivery";
import { resolveChecklist } from "../lib/qc/checklist";
import { shops } from "../lib/db/schema";

installMockTransport();

const rows: { step: string; result: string; ok: boolean }[] = [];
function report(step: string, ok: boolean, result: string) {
  rows.push({ step, ok, result });
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}: ${result}`);
}
function must(cond: unknown, step: string, result: string) {
  report(step, Boolean(cond), result);
  if (!cond) throw new Error(`Step failed: ${step} (${result})`);
}

async function counts() {
  return withSystemContext(async (tx) => {
    const bySource = await tx.select({ source: orders.source, n: sql<number>`count(*)::int` }).from(orders).groupBy(orders.source);
    const byStatus = await tx.select({ status: orders.status, n: sql<number>`count(*)::int` }).from(orders).groupBy(orders.status);
    const [msg] = await tx.select({ n: sql<number>`count(*)::int` }).from(messages);
    const [ev] = await tx.select({ n: sql<number>`count(*)::int` }).from(alphaEvents);
    return { bySource, byStatus, messages: msg.n, alphaEvents: ev.n };
  });
}

async function main() {
  const before = await counts();
  const totalBefore = before.bySource.reduce((a, r) => a + r.n, 0);

  // ---- 1. shop sync -------------------------------------------------------
  const sync = await syncAllShops({ trigger: "manual", budgetMs: 900_000 });
  const after1 = await counts();
  const total1 = after1.bySource.reduce((a, r) => a + r.n, 0);
  must(sync.processed === 4, "1. sync ran every onboarded shop", `${sync.processed} shops: ${sync.shops.map((s) => `${s.platform}=${s.outcome}`).join(", ")}`);
  must(total1 > totalBefore, "1. orders imported from Shopify + Etsy", `${totalBefore} -> ${total1} orders (${after1.bySource.map((r) => `${r.source}=${r.n}`).join(", ")})`);

  // ---- 2. mailbox poll ----------------------------------------------------
  const poll = await pollMailboxesScheduled({ budgetMs: 600_000 });
  const polled = poll.mailboxes;
  const attached = poll.attached;
  must(attached > 0, "2. Etsy notification emails attached", `${attached} attached across ${polled.length} mailbox(es): ${polled.map((r) => `${r.skippedRun ?? "ok"} fetched=${r.fetched}`).join("; ")}`);
  const etsyMsgs = await withSystemContext((tx) =>
    tx.select({ kind: sql<string>`metadata->>'kind'`, matched: sql<boolean>`order_id is not null`, n: sql<number>`count(*)::int` }).from(messages).where(eq(messages.channel, "etsy")).groupBy(sql`metadata->>'kind'`, sql`order_id is not null`),
  );
  report("2. sale + message emails parsed", true, etsyMsgs.map((r) => `${r.kind}${r.matched ? " (matched)" : " (unmatched)"}=${r.n}`).join(", "));

  // ---- 3. email flush -----------------------------------------------------
  const flush1 = await flushQueued();
  must(flush1.failed === 0, "3. queued customer emails sent via Gmail", `sent=${flush1.sent} failed=${flush1.failed} skipped=${flush1.skipped}`);

  // ---- 4. designer lane on one fresh Shopify order -------------------------
  const pixart = await withSystemContext(async (tx) => {
    const [b] = await tx.select({ id: businesses.id }).from(businesses).where(eq(businesses.slug, "pixart"));
    const [va] = await tx.select({ id: users.id }).from(users).where(eq(users.email, "va1@aystudios.io"));
    return { businessId: b.id, va: { id: va.id, role: "va" as const } as RequestUser };
  });
  const target = await withSystemContext(async (tx) => {
    const [o] = await tx
      .select({ id: orders.id, status: orders.status, number: orders.platformOrderName, platformOrderId: orders.platformOrderId, customerId: orders.customerId })
      .from(orders)
      .innerJoin(orderItems, eq(orderItems.orderId, orders.id))
      .innerJoin(assignments, and(eq(assignments.orderId, orders.id), eq(assignments.active, true)))
      .where(and(eq(orders.businessId, pixart.businessId), eq(orders.source, "shopify"), eq(orderItems.productType, "physical"), sql`${orders.status} in ('ready_to_assign','in_design')`, sql`${orders.platformOrderId} ~ '^[0-9]+$'`))
      .orderBy(desc(orders.placedAt))
      .limit(1);
    return o ?? null;
  });
  must(target, "4. a fresh physical Shopify order to walk", target ? `${target.number} (${target.status})` : "none imported");
  const t = target!;
  const assignment = await withSystemContext(async (tx) => {
    const [a] = await tx.select({ designerId: assignments.designerId }).from(assignments).where(and(eq(assignments.orderId, t.id), eq(assignments.active, true))).limit(1);
    if (a) return a.designerId;
    const r = await runAutoAssign(tx, { orderId: t.id, businessId: pixart.businessId, assignedBy: pixart.va.id });
    return r.assigned;
  });
  must(assignment, "4. designer assigned", assignment ? `designer ${assignment.slice(0, 8)}` : "no designer had capacity");
  if (t.status === "ready_to_assign") await transitionAsSystem({ orderId: t.id, to: "in_design", expectedFrom: "ready_to_assign", metadata: { via: "mock_walk" } });
  await withSystemContext((tx) =>
    tx.insert(assets).values({ businessId: pixart.businessId, orderId: t.id, type: "submission", storage: "cdn", url: `https://picsum.photos/seed/${t.number}-final/1200/1500`, uploadedBy: assignment! }),
  );
  await transitionAsSystem({ orderId: t.id, to: "awaiting_qc", expectedFrom: "in_design", metadata: { via: "mock_walk" } });
  // QC pass = the VA ticks every item on the shop's checklist (the same
  // itemResults the QC screen posts).
  await withSystemContext(async (tx) => {
    const [o] = await tx.select({ shopId: orders.shopId }).from(orders).where(eq(orders.id, t.id));
    const [shop] = await tx.select({ checklistVersion: shops.checklistVersion, integrationConfig: shops.integrationConfig }).from(shops).where(eq(shops.id, o.shopId));
    const checklist = resolveChecklist({ checklistVersion: shop?.checklistVersion ?? 1, integrationConfig: shop?.integrationConfig ?? null });
    const itemResults = Object.fromEntries(checklist.items.map((it) => [it.key, true]));
    await runTransition(tx, pixart.va, { orderId: t.id, to: "awaiting_approval", expectedFrom: "awaiting_qc", metadata: { via: "mock_walk", itemResults } });
  });
  const proof = await withSystemContext(async (tx) => {
    const [p] = await tx.select({ token: proofs.token }).from(proofs).where(and(eq(proofs.orderId, t.id), isNull(proofs.decision))).limit(1);
    const [draft] = await tx.select({ id: messages.id, status: messages.status }).from(messages).where(and(eq(messages.orderId, t.id), eq(messages.templateKey, "proof_ready"))).limit(1);
    return { token: p?.token ?? null, draft };
  });
  must(proof.token && proof.draft, "4. submit -> QC pass -> proof + proof email drafted", `proof ${proof.token ? "issued" : "missing"}, email ${proof.draft?.status ?? "missing"}`);

  // ---- 5. customer window --------------------------------------------------
  // The VA approves the draft (one click in Emails); the flush sends it.
  await withSystemContext((tx) => tx.update(messages).set({ status: "queued" }).where(eq(messages.id, proof.draft!.id)));
  const flush2 = await flushQueued(pixart.businessId);
  must(flush2.sent >= 1, "5. proof email sent to the customer", `sent=${flush2.sent} (mock Gmail thread ${mockState().sentProofThreads.at(-1)?.threadId ?? "?"})`);
  await new Promise((r) => setTimeout(r, 1200));
  const reply = await pollMailbox(pixart.businessId);
  const classified = await withSystemContext(async (tx) => {
    const [m] = await tx
      .select({ id: messages.id, body: messages.body, cls: sql<string>`metadata->'replyClassification'->>'intent'`, conf: sql<string>`metadata->'replyClassification'->>'confidence'` })
      .from(messages)
      .where(and(eq(messages.orderId, t.id), eq(messages.direction, "inbound"), eq(messages.channel, "email")))
      .orderBy(desc(messages.createdAt))
      .limit(1);
    return m ?? null;
  });
  must(classified, "5. customer reply landed on the order", classified ? `"${(classified.body ?? "").split("\n")[0]}" (poll attached=${reply.attached})` : `no reply attached (poll: ${JSON.stringify(reply.skippedReasons)})`);
  report("5. reply classified by the model", Boolean(classified?.cls), classified?.cls ? `${classified.cls} @ ${classified.conf}` : "no classification stored");
  const approved = await approveProof(proof.token!, { via: "mock_walk_customer_link" });
  must(approved.ok, "5. customer approves the proof", approved.ok ? "order -> approved" : `${approved.code}: ${approved.message}`);

  // ---- 6. print --------------------------------------------------------------
  const printed = await withSystemContext((tx) => recordManualPrintSignal(tx, pixart.va, { orderId: t.id, provider: "gelato" }));
  must(printed.ok, "6. sent to print (Gelato)", printed.message);
  const recon = await reconcileAllBusinesses("manual");
  const mine = recon.flatMap((r) => r.results).find((r) => r.orderId === t.id);
  const finalOrder = await withSystemContext(async (tx) => {
    const [o] = await tx.select({ status: orders.status }).from(orders).where(eq(orders.id, t.id));
    const [job] = await tx.select({ status: printJobs.status, tracking: printJobs.trackingNumber, carrier: printJobs.trackingCompany, providerOrderId: printJobs.providerOrderId, shopifyFulfillmentId: printJobs.shopifyFulfillmentId }).from(printJobs).where(eq(printJobs.orderId, t.id)).orderBy(desc(printJobs.createdAt)).limit(1);
    return { status: o.status, job };
  });
  must(mine && ["matched", "shipped", "no_change"].includes(mine.outcome), "6. reconcile found the provider order", mine ? `${mine.outcome} at ${mine.provider}` : "order not in the sweep");
  report("6. tracking pulled + Shopify fulfilled + shipped email", Boolean(finalOrder.job?.tracking), `order ${finalOrder.status}, job ${finalOrder.job?.status ?? "?"}, ${finalOrder.job?.carrier ?? "?"} ${finalOrder.job?.tracking ?? "(no tracking: provider still printing)"}, fulfilment ${finalOrder.job?.shopifyFulfillmentId ? "created" : "pending"}`);
  const flush3 = await flushQueued(pixart.businessId);
  report("6. stage emails flushed", flush3.failed === 0, `sent=${flush3.sent} failed=${flush3.failed}`);

  // ---- 7. sweeps -------------------------------------------------------------
  const sla = await runNotificationSweep(new Date());
  const rem = await runRemindersSweep({ now: new Date() });
  const lane = await withSystemContext((tx) => runDesignerLaneSweep(tx, new Date(), { enabled: true }));
  const events = await withSystemContext((tx) => tx.select({ type: alphaEvents.type, n: sql<number>`count(*)::int` }).from(alphaEvents).groupBy(alphaEvents.type));
  report("7. SLA + reminders + designer lane sweeps", true, `sla=${JSON.stringify(sla).slice(0, 120)}; reminders=${JSON.stringify(rem).slice(0, 120)}; lane=${JSON.stringify(lane).slice(0, 120)}`);
  must(events.length > 0, "7. Alpha events queued for the daemon", events.map((e) => `${e.type}=${e.n}`).join(", "));

  // ---- 8. daily health ---------------------------------------------------------
  const health = await deliverDailyHealthReports({ force: true, now: new Date() });
  report("8. daily health narrative (mock model) delivered", health.failed === 0, `processed=${health.processed} sent=${health.sent} skippedAlreadySent=${health.skippedAlreadySent} failed=${health.failed}`);

  // ---- summary -----------------------------------------------------------------
  const end = await counts();
  const trail = await withSystemContext((tx) => tx.select({ action: activityLog.action, at: activityLog.createdAt }).from(activityLog).where(eq(activityLog.orderId, t.id)).orderBy(activityLog.createdAt));
  console.log("\nWalked order " + t.number + " activity: " + trail.map((r) => r.action).join(" -> "));
  console.log("Orders by status: " + end.byStatus.map((r) => `${r.status}=${r.n}`).join(", "));
  console.log(`Messages: ${end.messages}, Alpha events: ${end.alphaEvents}`);
  console.log("\n| Step | Result |\n|---|---|");
  for (const r of rows) console.log(`| ${r.ok ? "PASS" : "FAIL"} ${r.step} | ${r.result.replace(/\|/g, "/")} |`);
  const failed = rows.filter((r) => !r.ok).length;
  console.log(`\n${rows.length - failed}/${rows.length} steps passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  console.log("\n| Step | Result |\n|---|---|");
  for (const r of rows) console.log(`| ${r.ok ? "PASS" : "FAIL"} ${r.step} | ${r.result.replace(/\|/g, "/")} |`);
  process.exit(1);
});
