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
 *   activity log rows, or Alpha events (the idempotency ledger).
 */
process.env.PRINT_PROVIDER_MOCK = "1";

import "./load-env";

import { randomUUID } from "node:crypto";
import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { eq, inArray, like } from "drizzle-orm";
import ws from "ws";

import { withSystemContext } from "../lib/db";
import * as schema from "../lib/db/schema";
import {
  activityLog,
  alphaEvents,
  businesses,
  orderItems,
  orders,
  printJobs,
  printReconcileLedger,
  shops,
} from "../lib/db/schema";
import { setBusinessPrintCredentials } from "../lib/db/credentials";
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
};
const orderIds = Object.values(ids).filter((v) => v !== ids.businessId && v !== ids.shopId);

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
    ]);
    await tx.insert(orderItems).values(
      orderIds.map((orderId) => ({
        businessId: ids.businessId,
        orderId,
        title: "A3 Framed Print",
        productType: "physical" as const,
        figureCount: 1,
        figureCountSource: "manual" as const,
      })),
    );
    await tx.insert(printJobs).values([
      mkJob(ids.shipped, "gelato", hoursAgo(2)),
      mkJob(ids.processing, "gelato", hoursAgo(2)),
      mkJob(ids.problem, "gelato", hoursAgo(2)),
      mkJob(ids.missing, "gelato", hoursAgo(13)), // past the 12h missing threshold
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

async function cleanup() {
  neonConfig.webSocketConstructor = ws;
  const pool = new Pool({ connectionString: process.env.DIRECT_URL ?? process.env.DATABASE_URL! });
  const ownerDb = drizzle(pool, { schema });
  try {
    await ownerDb.transaction(async (tx) => {
      await tx.delete(printReconcileLedger).where(eq(printReconcileLedger.businessId, ids.businessId));
      await tx.delete(alphaEvents).where(eq(alphaEvents.businessId, ids.businessId));
      await tx.delete(activityLog).where(eq(activityLog.businessId, ids.businessId));
      await tx.delete(printJobs).where(eq(printJobs.businessId, ids.businessId));
      await tx.delete(orderItems).where(inArray(orderItems.orderId, orderIds));
      await tx.delete(orders).where(inArray(orders.id, orderIds));
      await tx.delete(shops).where(eq(shops.id, ids.shopId));
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
    await setup();

    const run1 = await withSystemContext((tx) => reconcileBusinessPrintJobs(tx, ids.businessId));
    report(
      "shipped order: matched + tracking pulled + moved to shipped",
      run1.results.find((r) => r.orderId === ids.shipped)?.outcome === "shipped" && (await orderStatus(ids.shipped)) === "shipped",
      JSON.stringify({ outcome: run1.results.find((r) => r.orderId === ids.shipped), status: await orderStatus(ids.shipped), job: await jobFor(ids.shipped) }),
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
