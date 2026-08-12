/**
 * Designer payout invariants. Creates temporary orders/styles, drives the real
 * transition path, and deletes its rows at the end.
 */
import "./load-env";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";

import { withSystemContext, type RequestUser } from "../lib/db";
import {
  assignments,
  assets,
  earnings,
  orderItems,
  orders,
  shops,
  styles,
  users,
} from "../lib/db/schema";
import { recalculateBlockedEarning } from "../lib/orders/earnings";
import { transition, OrderTransitionError } from "../lib/orders/transitions";
import { DEFAULT_CHECKLIST } from "../lib/qc/checklist";

let failures = 0;
const cleanup = { orderIds: [] as string[], styleIds: [] as string[] };

function report(name: string, pass: boolean, detail: string) {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
  console.log(`      ${detail}`);
  if (!pass) failures += 1;
}

const passingItemResults = Object.fromEntries(DEFAULT_CHECKLIST.map((item) => [item.key, true]));

async function earningRows(orderId: string) {
  return withSystemContext((tx) =>
    tx
      .select({
        id: earnings.id,
        designerId: earnings.designerId,
        figureCount: earnings.figureCount,
        rate: earnings.rate,
        amount: earnings.amount,
        status: earnings.status,
        blockedReason: earnings.blockedReason,
        breakdown: earnings.breakdown,
      })
      .from(earnings)
      .where(eq(earnings.orderId, orderId)),
  );
}

async function createStyle(businessId: string, name: string, rate: string | null) {
  return withSystemContext(async (tx) => {
    const [style] = await tx
      .insert(styles)
      .values({ businessId, name, perFigureRate: rate })
      .returning({ id: styles.id });
    cleanup.styleIds.push(style.id);
    return style.id;
  });
}

async function createOrder(input: {
  businessId: string;
  shopId: string;
  designerId: string;
  status: "approved" | "fulfillment_only";
  style?: string | null;
  figureCount?: number | null;
  withItem?: boolean;
}) {
  return withSystemContext(async (tx) => {
    const id = randomUUID();
    await tx.insert(orders).values({
      id,
      businessId: input.businessId,
      shopId: input.shopId,
      platformOrderId: `EARN-${Date.now()}-${cleanup.orderIds.length}`,
      platformOrderName: `EARN-${cleanup.orderIds.length}`,
      status: input.status,
      source: "manual",
      uploadToken: randomUUID(),
    });
    cleanup.orderIds.push(id);

    if (input.withItem !== false) {
      await tx.insert(orderItems).values({
        businessId: input.businessId,
        orderId: id,
        title: "Temporary payout test item",
        figureCount: input.figureCount ?? 1,
        figureCountSource: input.figureCount == null ? "unresolved" : "manual",
        productType: "digital",
        style: input.style ?? null,
      });
    }

    await tx.insert(assignments).values({
      businessId: input.businessId,
      orderId: id,
      designerId: input.designerId,
      active: true,
      dueAt: new Date(Date.now() + 86400000),
    });
    return id;
  });
}

async function addSubmission(orderId: string) {
  await withSystemContext(async (tx) => {
    const [order] = await tx
      .select({ businessId: orders.businessId })
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);
    if (!order) throw new Error(`Order ${orderId} missing`);
    await tx.insert(assets).values({
      businessId: order.businessId,
      orderId,
      type: "submission",
      storage: "cdn",
      url: `https://example.com/${orderId}.jpg`,
    });
  });
}

async function cleanupRows() {
  await withSystemContext(async (tx) => {
    for (const orderId of cleanup.orderIds) await tx.delete(earnings).where(eq(earnings.orderId, orderId));
    for (const orderId of cleanup.orderIds) await tx.delete(orders).where(eq(orders.id, orderId));
    for (const styleId of cleanup.styleIds) await tx.delete(styles).where(eq(styles.id, styleId));
  });
}

async function main() {
  const ctx = await withSystemContext(async (tx) => {
    const [shop] = await tx.select({ id: shops.id, businessId: shops.businessId }).from(shops).limit(1);
    const [va] = await tx.select({ id: users.id }).from(users).where(eq(users.role, "va")).limit(1);
    const designers = await tx.select({ id: users.id }).from(users).where(eq(users.role, "designer")).limit(2);
    if (!shop) throw new Error("Need at least one shop in the database");
    if (!va) throw new Error("Need at least one VA in the database");
    if (designers.length < 2) throw new Error("Need at least two designers in the database");
    return { shopId: shop.id, businessId: shop.businessId, vaId: va.id, d1: designers[0].id, d2: designers[1].id };
  });
  const va: RequestUser = { id: ctx.vaId, role: "va" };

  try {
    const styleName = `Payout Test ${Date.now()}`;
    const styleId = await createStyle(ctx.businessId, styleName, "7.50");

    const orderId = await createOrder({
      businessId: ctx.businessId,
      shopId: ctx.shopId,
      designerId: ctx.d1,
      status: "approved",
      style: styleName,
      figureCount: 2,
    });
    await transition(va, { orderId, to: "complete", expectedFrom: "approved" });
    let rows = await earningRows(orderId);
    report(
      "completed order creates exactly one earning at the style rate",
      rows.length === 1 && rows[0].designerId === ctx.d1 && rows[0].rate === "7.50" && rows[0].amount === "15.00",
      `rows=${rows.length}, designer=${rows[0]?.designerId}, rate=${rows[0]?.rate}, amount=${rows[0]?.amount}`,
    );

    await withSystemContext((tx) => tx.update(styles).set({ perFigureRate: "10.00" }).where(eq(styles.id, styleId)));
    rows = await earningRows(orderId);
    report(
      "changing a style rate leaves past earnings untouched",
      rows[0]?.rate === "7.50" && rows[0]?.amount === "15.00",
      `stored rate=${rows[0]?.rate}, amount=${rows[0]?.amount}`,
    );

    await transition(va, { orderId, to: "in_design", expectedFrom: "complete", metadata: { revisionReason: "Regression test" } });
    await addSubmission(orderId);
    await transition(va, { orderId, to: "awaiting_qc", expectedFrom: "in_design" });
    await transition(va, { orderId, to: "awaiting_approval", expectedFrom: "awaiting_qc", metadata: { itemResults: passingItemResults } });
    await transition(va, { orderId, to: "approved", expectedFrom: "awaiting_approval" });
    await transition(va, { orderId, to: "complete", expectedFrom: "approved" });
    rows = await earningRows(orderId);
    report(
      "revision round-trip creates no second earning",
      rows.length === 1 && rows[0].amount === "15.00",
      `rows=${rows.length}, amount=${rows[0]?.amount}`,
    );

    const reassignedOrderId = await createOrder({
      businessId: ctx.businessId,
      shopId: ctx.shopId,
      designerId: ctx.d1,
      status: "approved",
      style: styleName,
      figureCount: 1,
    });
    await withSystemContext(async (tx) => {
      await tx.update(assignments).set({ active: false }).where(and(eq(assignments.orderId, reassignedOrderId), eq(assignments.active, true)));
      await tx.insert(assignments).values({
        businessId: ctx.businessId,
        orderId: reassignedOrderId,
        designerId: ctx.d2,
        active: true,
        dueAt: new Date(Date.now() + 86400000),
      });
    });
    await transition(va, { orderId: reassignedOrderId, to: "complete", expectedFrom: "approved" });
    rows = await earningRows(reassignedOrderId);
    report(
      "reassignment before completion pays the new designer",
      rows.length === 1 && rows[0].designerId === ctx.d2,
      `paid designer=${rows[0]?.designerId}, expected=${ctx.d2}`,
    );

    const fulfillmentOrderId = await createOrder({
      businessId: ctx.businessId,
      shopId: ctx.shopId,
      designerId: ctx.d1,
      status: "fulfillment_only",
      style: styleName,
      figureCount: 1,
    });
    await transition(va, { orderId: fulfillmentOrderId, to: "complete", expectedFrom: "fulfillment_only" });
    rows = await earningRows(fulfillmentOrderId);
    report("fulfillment_only order creates no earning", rows.length === 0, `rows=${rows.length}`);

    const blockedStyleName = `Blocked Payout Test ${Date.now()}`;
    const blockedStyleId = await createStyle(ctx.businessId, blockedStyleName, null);
    const blockedOrderId = await createOrder({
      businessId: ctx.businessId,
      shopId: ctx.shopId,
      designerId: ctx.d1,
      status: "approved",
      style: blockedStyleName,
      figureCount: 3,
    });
    await transition(va, { orderId: blockedOrderId, to: "complete", expectedFrom: "approved" });
    rows = await earningRows(blockedOrderId);
    report(
      "missing style rate creates a blocked earning instead of blocking completion",
      rows.length === 1 && rows[0].status === "blocked" && rows[0].amount == null,
      `status=${rows[0]?.status}, amount=${rows[0]?.amount}, reason=${rows[0]?.blockedReason}`,
    );
    await withSystemContext((tx) => tx.update(styles).set({ perFigureRate: "4.00" }).where(eq(styles.id, blockedStyleId)));
    const resolved = await withSystemContext((tx) => recalculateBlockedEarning(tx, rows[0].id, ctx.businessId));
    rows = await earningRows(blockedOrderId);
    report(
      "blocked earning resolves after rate is configured",
      resolved.ok && rows[0].status === "pending" && rows[0].amount === "12.00",
      `resolved=${resolved.ok}, status=${rows[0]?.status}, amount=${rows[0]?.amount}`,
    );

    const noItemOrderId = await createOrder({
      businessId: ctx.businessId,
      shopId: ctx.shopId,
      designerId: ctx.d1,
      status: "approved",
      withItem: false,
    });
    let precondition = false;
    try {
      await transition(va, { orderId: noItemOrderId, to: "complete", expectedFrom: "approved" });
    } catch (e) {
      precondition = e instanceof OrderTransitionError && e.code === "precondition";
    }
    report("missing order items still block completion", precondition, precondition ? "precondition thrown" : "no precondition");
  } finally {
    await cleanupRows();
  }

  console.log(`\n${failures === 0 ? "ALL PASSED" : failures + " FAILED"}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error("test-earnings crashed:", e);
  await cleanupRows().catch(() => undefined);
  process.exit(1);
});
