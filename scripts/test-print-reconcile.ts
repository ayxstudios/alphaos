/**
 * Print reconciliation invariants (lib/print/reconcile.ts), all against
 * PRINT_PROVIDER_MOCK=1 fixtures (no live Gelato/Luma Prints keys exist yet):
 * - a printing order whose provider order has shipped gets tracking pulled
 *   and is moved to `shipped`;
 * - a printing order still in production is left alone (no event, no move);
 * - a printing order the provider failed/cancelled raises a `va.attention`
 *   Alpha event and stays in `printing` for a human to decide;
 * - a printing order with nothing at the provider after its grace window
 *   raises `order.missed_print` to both va and admin, exactly once;
 * - an `approved` physical order that was never logged as sent, but the
 *   provider actually has it, self-heals: a print_jobs row is created and the
 *   order moves straight to `printing` (and on to `shipped` if the provider
 *   already shows a shipment) - the VA forgetting to click "Sent to print"
 *   never leaves an order silently stuck;
 * - running the whole sweep twice produces no duplicate ledger rows,
 *   activity log rows, or Alpha events (the idempotency ledger);
 * - an order Gelato split into two parts (lib/print/parts.ts) is followed
 *   part by part: both shipped = one shipped email listing both numbers;
 *   one shipped = nothing until the other ships, or until 3 days have passed
 *   (then an email for the first, the order stays printing), and the later
 *   part gets its own short email. No number is ever emailed twice.
 */
process.env.PRINT_PROVIDER_MOCK = "1";

import "./load-env";

import { randomUUID } from "node:crypto";
import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { and, eq, inArray, like } from "drizzle-orm";
import ws from "ws";

import { withSystemContext } from "../lib/db";
import * as schema from "../lib/db/schema";
import {
  activityLog,
  alphaEvents,
  businesses,
  customers,
  messages,
  orderItems,
  orders,
  printJobs,
  printReconcileLedger,
  shops,
} from "../lib/db/schema";
import { setBusinessPrintCredentials } from "../lib/db/credentials";
import { gelatoStatusToNormalized } from "../lib/integrations/gelato/client";
import { GELATO_FIXTURES, splitPart } from "../lib/integrations/gelato/fixtures";
import { pickParts, planShipmentNotice, PART_WAIT_MS, type PrintPartRow } from "../lib/print/parts";
import { reconcileBusinessPrintJobs } from "../lib/print/reconcile";

let failures = 0;
function report(name: string, pass: boolean, detail: string) {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
  console.log(`      ${detail}`);
  if (!pass) failures += 1;
}

const suffix = Date.now();
const ids = {
  businessId: randomUUID(),
  shopId: randomUUID(),
  shipped: randomUUID(), // PC-1001, printing, gelato -> shipped
  processing: randomUUID(), // PC-1002, printing, gelato -> matched, no move
  problem: randomUUID(), // PC-1003, printing, gelato -> problem
  missing: randomUUID(), // PC-9999 (no fixture), printing, gelato, 13h old -> missing
  selfHeal: randomUUID(), // PC-1004, approved/no job/25h old, gelato -> self-heals to printing
  lumaSelfHeal: randomUUID(), // PC-2001, approved/no job/25h old, lumaprints -> self-heals to shipped
  splitBoth: randomUUID(), // PC-1101, printing, two gelato parts both in transit -> shipped, one email
  splitOne: randomUUID(), // PC-1102, printing, one part in transit, one in production -> waits; a legacy stub (only item digital)
  customerId: randomUUID(),
};
const orderIds = Object.values(ids).filter((v) => v !== ids.businessId && v !== ids.shopId && v !== ids.customerId);
const SPLIT = {
  both: [GELATO_FIXTURES["PC-1101"].id, GELATO_FIXTURES["PC-1101#2"].id],
  one: [GELATO_FIXTURES["PC-1102"].id, GELATO_FIXTURES["PC-1102#2"].id],
};

const hoursAgo = (h: number) => new Date(Date.now() - h * 60 * 60 * 1000);

async function setup() {
  await withSystemContext(async (tx) => {
    await tx.insert(businesses).values({ id: ids.businessId, name: "Print Reconcile Test", slug: `print-reconcile-${suffix}` });
    await tx.insert(shops).values({
      id: ids.shopId,
      businessId: ids.businessId,
      platform: "shopify",
      name: "Print Reconcile Shop",
      externalShopId: `print-reconcile-${suffix}.myshopify.com`,
      credentials: {},
    });
    await tx.insert(customers).values({
      id: ids.customerId,
      businessId: ids.businessId,
      email: `print-reconcile-${suffix}@example.com`,
      firstName: "Lori",
    });
    await setBusinessPrintCredentials(tx, ids.businessId, {
      gelato: { apiKey: "test-key", webhookSecret: "test-secret" },
      lumaprints: { username: "test-user", password: "test-pass", storeId: "818" },
    });

    await tx.insert(orders).values([
      mkOrder(ids.shipped, "PC-1001", "printing"),
      mkOrder(ids.processing, "PC-1002", "printing"),
      mkOrder(ids.problem, "PC-1003", "printing"),
      mkOrder(ids.missing, "PC-9999", "printing"),
      mkOrder(ids.selfHeal, "PC-1004", "approved", hoursAgo(25)),
      mkOrder(ids.lumaSelfHeal, "PC-2001", "approved", hoursAgo(25)),
      mkOrder(ids.splitBoth, "PC-1101", "printing"),
      mkOrder(ids.splitOne, "PC-1102", "printing"),
    ]);
    await tx.insert(orderItems).values(
      orderIds.map((orderId) => ({
        businessId: ids.businessId,
        orderId,
        title: "A3 Framed Print",
        // Lori PC32062: a legacy stub's only item is digital, but its parts are at the printer, so it is followed.
        productType: (orderId === ids.splitOne ? "digital" : "physical") as "digital" | "physical",
        figureCount: 1,
        figureCountSource: "manual" as const,
      })),
    );
    await tx.insert(printJobs).values([
      mkJob(ids.shipped, "gelato", hoursAgo(2)),
      mkJob(ids.processing, "gelato", hoursAgo(2)),
      mkJob(ids.problem, "gelato", hoursAgo(2)),
      mkJob(ids.missing, "gelato", hoursAgo(13)), // past the 12h missing threshold
      // As the agent's print road writes them: one row per part, connectedTo = the paid order.
      mkPart(ids.splitBoth, SPLIT.both[0], null, hoursAgo(3)),
      mkPart(ids.splitBoth, SPLIT.both[1], SPLIT.both[0], hoursAgo(2)),
      mkPart(ids.splitOne, SPLIT.one[0], null, hoursAgo(3)),
      mkPart(ids.splitOne, SPLIT.one[1], SPLIT.one[0], hoursAgo(2)),
    ]);
  });
}

function mkOrder(id: string, platformOrderName: string, status: "printing" | "approved", updatedAt?: Date) {
  return {
    id,
    businessId: ids.businessId,
    shopId: ids.shopId,
    platformOrderId: platformOrderName,
    platformOrderName,
    status,
    source: "manual" as const,
    customerId: ids.customerId,
    placedAt: hoursAgo(30),
    ...(updatedAt ? { updatedAt } : {}),
  };
}

function mkJob(orderId: string, provider: "gelato" | "lumaprints", submittedAt: Date) {
  return {
    businessId: ids.businessId,
    orderId,
    provider,
    method: "manual" as const,
    status: "sent_to_print",
    submittedAt,
  };
}

function mkPart(orderId: string, providerOrderId: string, connectedTo: string | null, at: Date) {
  return {
    ...mkJob(orderId, "gelato", at),
    providerOrderId,
    providerPayload: { source: "agent_print_road", ...(connectedTo ? { connectedTo } : {}) },
    createdAt: at,
  };
}

async function cleanup() {
  neonConfig.webSocketConstructor = ws;
  const pool = new Pool({ connectionString: process.env.DIRECT_URL ?? process.env.DATABASE_URL! });
  const ownerDb = drizzle(pool, { schema });
  try {
    await ownerDb.transaction(async (tx) => {
      await tx.delete(printReconcileLedger).where(eq(printReconcileLedger.businessId, ids.businessId));
      await tx.delete(alphaEvents).where(eq(alphaEvents.businessId, ids.businessId));
      await tx.delete(activityLog).where(eq(activityLog.businessId, ids.businessId));
      await tx.delete(messages).where(eq(messages.businessId, ids.businessId));
      await tx.delete(printJobs).where(eq(printJobs.businessId, ids.businessId));
      await tx.delete(orderItems).where(inArray(orderItems.orderId, orderIds));
      await tx.delete(orders).where(inArray(orders.id, orderIds));
      await tx.delete(shops).where(eq(shops.id, ids.shopId));
      await tx.delete(customers).where(eq(customers.id, ids.customerId));
      await tx.delete(businesses).where(eq(businesses.id, ids.businessId));
    });
  } finally {
    await pool.end();
  }
}

async function orderStatus(orderId: string): Promise<string> {
  return withSystemContext(async (tx) => {
    const [row] = await tx.select({ status: orders.status }).from(orders).where(eq(orders.id, orderId)).limit(1);
    return row?.status ?? "(missing)";
  });
}

async function jobFor(orderId: string) {
  return withSystemContext(async (tx) => {
    const [row] = await tx.select().from(printJobs).where(eq(printJobs.orderId, orderId)).limit(1);
    return row ?? null;
  });
}

async function shippedEmails(orderId: string) {
  return withSystemContext((tx) =>
    tx
      .select({ body: messages.body, dedupeKey: messages.dedupeKey })
      .from(messages)
      .where(and(eq(messages.orderId, orderId), eq(messages.templateKey, "shipped")))
      .orderBy(messages.createdAt)
      .then((rows) => rows.map((r) => ({ ...r, body: r.body ?? "" }))),
  );
}

async function partsOf(orderId: string) {
  return withSystemContext((tx) => tx.select().from(printJobs).where(eq(printJobs.orderId, orderId)).orderBy(printJobs.createdAt));
}

/** No database: which rows are one order's parts, and what the buyer hears when. */
function pureChecks() {
  const at = (h: number) => hoursAgo(h);
  const row = (id: string, poid: string | null, h: number, extra: Partial<PrintPartRow> = {}): PrintPartRow => ({
    id,
    provider: "gelato",
    providerOrderId: poid,
    reconcileState: "matched",
    providerStatus: null,
    submittedAt: at(h),
    createdAt: at(h),
    trackingNumber: null,
    trackingCompany: null,
    trackingUrl: null,
    shippedAt: null,
    shopifyFulfillmentId: null,
    platformSyncedAt: null,
    platformSyncError: null,
    providerPayload: {},
    providerResponse: {},
    ...extra,
  });

  const single = pickParts([row("a", "g1", 1)]);
  const split = pickParts([row("b", "g2", 1, { providerPayload: { connectedTo: "g1" } }), row("a", "g1", 2)]);
  const viaGelato = pickParts([row("b", "g2", 1), row("a", "g1", 2, { providerResponse: { connectedOrderIds: ["g1", "g2"] } })]);
  const duplicate = pickParts([row("p", "g1", 1), row("a", "g1", 2, { trackingNumber: "T1" })]);
  const replacement = pickParts([row("r", "g9", 1), row("a", "g1", 30, { reconcileState: "shipped", trackingNumber: "T1" })]);
  report(
    "parts: one print = one part; connectedTo or Gelato's connectedOrderIds join a split; same printer id = one part (the tracked row); a replacement stands alone",
    single.length === 1 &&
      split.map((p) => p.id).join() === "a,b" &&
      viaGelato.length === 2 &&
      duplicate.length === 1 && duplicate[0].id === "a" &&
      replacement.length === 1 && replacement[0].id === "r",
    JSON.stringify({ single: single.length, split: split.map((p) => p.id), viaGelato: viaGelato.length, duplicate: duplicate.map((p) => p.id), replacement: replacement.map((p) => p.id) }),
  );

  const shipped = (id: string, poid: string, n: string, h: number) =>
    row(id, poid, 10, { reconcileState: "shipped", trackingNumber: n, shippedAt: at(h) });
  const none = new Set<string>();
  const oneOnly = planShipmentNotice([shipped("a", "g1", "T1", 1)], none);
  const bothShipped = planShipmentNotice([shipped("a", "g1", "T1", 1), shipped("b", "g2", "T2", 1)], none);
  const halfFresh = planShipmentNotice([shipped("a", "g1", "T1", 1), row("b", "g2", 10)], none);
  const halfOld = planShipmentNotice([shipped("a", "g1", "T1", PART_WAIT_MS / 3_600_000 + 1), row("b", "g2", 10)], none);
  const halfOldTold = planShipmentNotice([shipped("a", "g1", "T1", PART_WAIT_MS / 3_600_000 + 1), row("b", "g2", 10)], new Set(["T1"]));
  const otherCancelled = planShipmentNotice([shipped("a", "g1", "T1", 1), row("b", "g2", 10, { reconcileState: "problem" })], none);
  const otherDeliveredBlind = planShipmentNotice(
    [shipped("a", "g1", "T1", 1), row("b", "g2", 10, { reconcileState: "shipped", providerStatus: "delivered" })],
    none,
  );
  report(
    "notice: one part shipped = all; both = all; one of two under 3 days = wait, over = early, once; a cancelled or numberless delivered part is not waited for",
    oneOnly.kind === "all" &&
      bothShipped.kind === "all" && bothShipped.untold.length === 2 &&
      halfFresh.kind === "wait" &&
      halfOld.kind === "early" && halfOld.untold.length === 1 &&
      halfOldTold.kind === "wait" &&
      otherCancelled.kind === "all" &&
      otherDeliveredBlind.kind === "all",
    JSON.stringify({ oneOnly: oneOnly.kind, bothShipped: bothShipped.kind, halfFresh: halfFresh.kind, halfOld: halfOld.kind, halfOldTold: halfOldTold.kind, otherCancelled: otherCancelled.kind, otherDeliveredBlind: otherDeliveredBlind.kind }),
  );

  // Gelato v4 puts tracking in shipment.packages[]; a package labelled while still in production is not a shipment.
  const inTransit = gelatoStatusToNormalized(splitPart("g1", "PC-1", [], "T1"));
  const labelled = gelatoStatusToNormalized({ ...splitPart("g1", "PC-1", [], "T1"), fulfillmentStatus: "in_production" });
  report(
    "gelato: an in_transit package is the shipment; the same package while in_production is not",
    inTransit.status === "shipped" && inTransit.shipments.length === 1 && inTransit.shipments[0].trackingNumber === "T1" &&
      labelled.status === "created" && labelled.shipments.length === 0,
    JSON.stringify({ inTransit: [inTransit.status, inTransit.shipments], labelled: [labelled.status, labelled.shipments] }),
  );
}

async function countLike(table: "activity" | "ledger" | "alpha", pattern: string): Promise<number> {
  return withSystemContext(async (tx) => {
    if (table === "activity") {
      const rows = await tx
        .select({ id: activityLog.id })
        .from(activityLog)
        .where(eq(activityLog.businessId, ids.businessId));
      const filtered = await tx
        .select({ id: activityLog.id })
        .from(activityLog)
        .where(like(activityLog.action, pattern));
      const idsInBiz = new Set(rows.map((r) => r.id));
      return filtered.filter((r) => idsInBiz.has(r.id)).length;
    }
    if (table === "ledger") {
      return (await tx.select({ id: printReconcileLedger.id }).from(printReconcileLedger).where(eq(printReconcileLedger.businessId, ids.businessId))).length;
    }
    return (await tx.select({ id: alphaEvents.id }).from(alphaEvents).where(eq(alphaEvents.businessId, ids.businessId))).length;
  });
}

async function main() {
  try {
    pureChecks();
    await setup();

    const run1 = await withSystemContext((tx) => reconcileBusinessPrintJobs(tx, ids.businessId));
    const singleMails = await shippedEmails(ids.shipped);
    report(
      "shipped order: matched + tracking pulled + moved to shipped, one shipped email with its number (one part, as before)",
      run1.results.find((r) => r.orderId === ids.shipped)?.outcome === "shipped" &&
        (await orderStatus(ids.shipped)) === "shipped" &&
        singleMails.length === 1 &&
        singleMails[0].dedupeKey === `stage:${ids.shipped}:shipped:392964503590` &&
        singleMails[0].body.includes("392964503590"),
      JSON.stringify({ outcome: run1.results.find((r) => r.orderId === ids.shipped), status: await orderStatus(ids.shipped), mails: singleMails, job: await jobFor(ids.shipped) }),
    );

    const bothMails = await shippedEmails(ids.splitBoth);
    const bothParts = await partsOf(ids.splitBoth);
    const bothResult = run1.results.find((r) => r.orderId === ids.splitBoth);
    report(
      "split order, both parts shipped: both followed, order shipped, ONE email listing both numbers",
      bothResult?.outcome === "shipped" &&
        bothResult.parts?.length === 2 &&
        (await orderStatus(ids.splitBoth)) === "shipped" &&
        bothParts.every((p) => p.reconcileState === "shipped" && p.trackingNumber) &&
        bothMails.length === 1 &&
        bothMails[0].body.includes("9400111899223100001101") &&
        bothMails[0].body.includes("9400111899223100001102"),
      JSON.stringify({ result: bothResult, status: await orderStatus(ids.splitBoth), mails: bothMails, parts: bothParts.map((p) => [p.providerOrderId, p.reconcileState, p.trackingNumber, p.trackingCompany]) }),
    );

    const oneParts = await partsOf(ids.splitOne);
    const oneResult = run1.results.find((r) => r.orderId === ids.splitOne);
    report(
      "split order (a legacy stub, only item digital, followed for its printer parts), one part shipped an hour ago: its tracking recorded, order stays printing, no email yet",
      oneResult?.outcome === "matched" &&
        (await orderStatus(ids.splitOne)) === "printing" &&
        oneParts[0].trackingNumber === "9400111899223100001201" &&
        !oneParts[1].trackingNumber &&
        (await shippedEmails(ids.splitOne)).length === 0,
      JSON.stringify({ result: oneResult, status: await orderStatus(ids.splitOne), parts: oneParts.map((p) => [p.providerOrderId, p.reconcileState, p.trackingNumber]) }),
    );

    const processingJob = await jobFor(ids.processing);
    report(
      "still-in-production order: matched, left in printing, no move",
      run1.results.find((r) => r.orderId === ids.processing)?.outcome === "matched" &&
        (await orderStatus(ids.processing)) === "printing" &&
        processingJob?.reconcileState === "matched",
      JSON.stringify({ status: await orderStatus(ids.processing), job: processingJob }),
    );

    const problemEvents = await withSystemContext((tx) =>
      tx.select().from(alphaEvents).where(eq(alphaEvents.orderId, ids.problem)),
    );
    report(
      "failed provider order: flagged as a problem, va.attention raised, stays in printing",
      run1.results.find((r) => r.orderId === ids.problem)?.outcome === "problem" &&
        (await orderStatus(ids.problem)) === "printing" &&
        problemEvents.length === 1 &&
        problemEvents[0].type === "va.attention" &&
        problemEvents[0].toRole === "va",
      JSON.stringify({ status: await orderStatus(ids.problem), events: problemEvents.map((e) => ({ type: e.type, toRole: e.toRole, text: e.text })) }),
    );

    const missingEvents = await withSystemContext((tx) =>
      tx.select().from(alphaEvents).where(eq(alphaEvents.orderId, ids.missing)),
    );
    report(
      "missing order past 12h: order.missed_print raised to both va and admin",
      run1.results.find((r) => r.orderId === ids.missing)?.outcome === "missing" &&
        missingEvents.length === 2 &&
        missingEvents.every((e) => e.type === "order.missed_print") &&
        new Set(missingEvents.map((e) => e.toRole)).size === 2,
      JSON.stringify({ events: missingEvents.map((e) => ({ type: e.type, toRole: e.toRole })) }),
    );

    report(
      "approved + never logged, but Gelato has it: self-heals to printing",
      run1.results.find((r) => r.orderId === ids.selfHeal)?.outcome === "matched" && (await orderStatus(ids.selfHeal)) === "printing",
      JSON.stringify({ status: await orderStatus(ids.selfHeal), job: await jobFor(ids.selfHeal) }),
    );

    report(
      "approved + never logged, Luma Prints already shipped it: self-heals straight to shipped",
      run1.results.find((r) => r.orderId === ids.lumaSelfHeal)?.outcome === "shipped" && (await orderStatus(ids.lumaSelfHeal)) === "shipped",
      JSON.stringify({ status: await orderStatus(ids.lumaSelfHeal), job: await jobFor(ids.lumaSelfHeal) }),
    );

    const ledgerAfter1 = await countLike("ledger", "");
    const alphaAfter1 = await countLike("alpha", "");
    const reconcileActivityAfter1 = await countLike("activity", "print.reconcile_%");

    const run2 = await withSystemContext((tx) => reconcileBusinessPrintJobs(tx, ids.businessId));
    const ledgerAfter2 = await countLike("ledger", "");
    const alphaAfter2 = await countLike("alpha", "");
    const reconcileActivityAfter2 = await countLike("activity", "print.reconcile_%");

    report(
      "idempotent: a second sweep adds no ledger rows, no Alpha events, no reconcile activity",
      ledgerAfter1 === ledgerAfter2 && alphaAfter1 === alphaAfter2 && reconcileActivityAfter1 === reconcileActivityAfter2,
      JSON.stringify({ ledgerAfter1, ledgerAfter2, alphaAfter1, alphaAfter2, reconcileActivityAfter1, reconcileActivityAfter2, run2Outcomes: run2.results }),
    );

    // Three days on and the frame is still being made: the buyer hears about the canvas now, once.
    await withSystemContext((tx) =>
      tx.update(printJobs).set({ shippedAt: hoursAgo(PART_WAIT_MS / 3_600_000 + 2) }).where(eq(printJobs.providerOrderId, SPLIT.one[0])),
    );
    await withSystemContext((tx) => reconcileBusinessPrintJobs(tx, ids.businessId));
    await withSystemContext((tx) => reconcileBusinessPrintJobs(tx, ids.businessId));
    const earlyMails = await shippedEmails(ids.splitOne);
    report(
      "split order, first part shipped over 3 days ago: one email for it (not repeated), order stays printing",
      (await orderStatus(ids.splitOne)) === "printing" &&
        earlyMails.length === 1 &&
        earlyMails[0].body.includes("9400111899223100001201") &&
        !earlyMails[0].body.includes("9400111899223100001202"),
      JSON.stringify({ status: await orderStatus(ids.splitOne), mails: earlyMails }),
    );

    // Then the frame ships: its own short email, and the order is shipped.
    GELATO_FIXTURES["PC-1102#2"] = splitPart(SPLIT.one[1], "PC-1102", [SPLIT.one[0]], "9400111899223100001202");
    await withSystemContext((tx) => reconcileBusinessPrintJobs(tx, ids.businessId));
    const laterMails = await shippedEmails(ids.splitOne);
    report(
      "split order, later part ships: a second email with only the new number, order shipped",
      (await orderStatus(ids.splitOne)) === "shipped" &&
        laterMails.length === 2 &&
        laterMails[1].body.includes("9400111899223100001202") &&
        !laterMails[1].body.includes("9400111899223100001201"),
      JSON.stringify({ status: await orderStatus(ids.splitOne), mails: laterMails }),
    );

    report(
      "mock mode served every fixture (no live keys needed to test)",
      run1.checked === orderIds.length && run1.errors.length === 0,
      JSON.stringify({ checked: run1.checked, errors: run1.errors }),
    );
  } finally {
    await cleanup();
  }

  console.log(`\n${failures === 0 ? "ALL PASSED" : failures + " FAILED"}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error("test-print-reconcile crashed:", error);
  await cleanup().catch(() => undefined);
  process.exit(1);
});
