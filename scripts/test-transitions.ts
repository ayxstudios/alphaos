/**
 * Proves the order state machine's role gate: a DESIGNER cannot self-approve or
 * otherwise advance an order past QC by any path (including a crafted request
 * straight to transition()). Also checks optimistic-concurrency (stale) and a
 * staff positive control. Prints PASS/FAIL per assertion; exits non-zero on fail.
 */
import "./load-env";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";

import { withSystemContext, type RequestUser } from "../lib/db";
import { orders, orderItems, assignments, users, shops, designerBusinesses, assets } from "../lib/db/schema";
import { DEFAULT_CHECKLIST } from "../lib/qc/checklist";
import {
  transition,
  OrderTransitionError,
  StaleTransitionError,
  type OrderStatus,
} from "../lib/orders/transitions";

let failures = 0;
function report(name: string, pass: boolean, detail: string) {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
  console.log(`      ${detail}`);
  if (!pass) failures += 1;
}

const passingItemResults = Object.fromEntries(
  DEFAULT_CHECKLIST.map((item) => [item.key, true]),
);

async function statusOf(orderId: string): Promise<string> {
  return withSystemContext(async (tx) => {
    const [o] = await tx.select({ status: orders.status }).from(orders).where(eq(orders.id, orderId));
    return o?.status ?? "(missing)";
  });
}

async function statusRevisionOf(orderId: string): Promise<{ status: string; revisionCount: number }> {
  return withSystemContext(async (tx) => {
    const [o] = await tx
      .select({ status: orders.status, revisionCount: orders.revisionCount })
      .from(orders)
      .where(eq(orders.id, orderId));
    return { status: o?.status ?? "(missing)", revisionCount: o?.revisionCount ?? -1 };
  });
}

async function addSubmission(orderId: string): Promise<void> {
  await withSystemContext(async (tx) => {
    const [o] = await tx
      .select({ businessId: orders.businessId })
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);
    if (!o) throw new Error(`Order ${orderId} missing`);
    await tx.insert(assets).values({
      businessId: o.businessId,
      orderId,
      type: "submission",
      storage: "cdn",
      url: `https://example.com/${orderId}.jpg`,
    });
  });
}

async function expectThrow(
  name: string,
  orderId: string,
  fn: () => Promise<unknown>,
  mustStayAt: string,
) {
  let threw: OrderTransitionError | null = null;
  try {
    await fn();
  } catch (e) {
    if (e instanceof OrderTransitionError) threw = e;
    else throw e;
  }
  const status = await statusOf(orderId);
  report(name, !!threw && status === mustStayAt, threw ? `rejected (${threw.code}); status still ${status}` : `NOT rejected; status ${status}`);
}

async function main() {
  // --- setup: a resolved in_design order assigned to designer d2 -----------
  const ctx = await withSystemContext(async (tx) => {
    const [d2] = await tx.select({ id: users.id }).from(users).where(eq(users.email, "d2@aystudios.io"));
    const [va] = await tx.select({ id: users.id }).from(users).where(eq(users.email, "va1@aystudios.io"));
    // A shop in a business d2 belongs to.
    const [shop] = await tx
      .select({ id: shops.id, businessId: shops.businessId })
      .from(shops)
      .innerJoin(designerBusinesses, eq(designerBusinesses.businessId, shops.businessId))
      .where(and(eq(designerBusinesses.userId, d2.id), eq(shops.platform, "etsy")))
      .limit(1);

    const orderId = randomUUID();
    const noSubmissionOrderId = randomUUID();
    const lateOrderId = randomUUID();
    await tx.insert(orders).values({
      id: orderId,
      businessId: shop.businessId,
      shopId: shop.id,
      platformOrderId: `TEST-${Date.now()}`,
      status: "in_design",
      source: "manual",
      uploadToken: randomUUID(),
    });
    await tx.insert(orders).values({
      id: noSubmissionOrderId,
      businessId: shop.businessId,
      shopId: shop.id,
      platformOrderId: `NOSUB-${Date.now()}`,
      status: "in_design",
      source: "manual",
      uploadToken: randomUUID(),
    });
    await tx.insert(orders).values({
      id: lateOrderId,
      businessId: shop.businessId,
      shopId: shop.id,
      platformOrderId: `LATE-${Date.now()}`,
      status: "complete",
      source: "manual",
      uploadToken: randomUUID(),
    });
    await tx.insert(orderItems).values({
      businessId: shop.businessId,
      orderId,
      figureCount: 2,
      figureCountSource: "manual",
      productType: "digital",
    });
    await tx.insert(orderItems).values({
      businessId: shop.businessId,
      orderId: noSubmissionOrderId,
      figureCount: 1,
      figureCountSource: "manual",
      productType: "digital",
    });
    await tx.insert(orderItems).values({
      businessId: shop.businessId,
      orderId: lateOrderId,
      figureCount: 1,
      figureCountSource: "manual",
      productType: "digital",
    });
    await tx.insert(assignments).values({
      businessId: shop.businessId,
      orderId,
      designerId: d2.id,
      active: true,
      dueAt: new Date(Date.now() + 86400000),
    });
    await tx.insert(assignments).values({
      businessId: shop.businessId,
      orderId: noSubmissionOrderId,
      designerId: d2.id,
      active: true,
      dueAt: new Date(Date.now() + 86400000),
    });
    await tx.insert(assignments).values({
      businessId: shop.businessId,
      orderId: lateOrderId,
      designerId: d2.id,
      active: true,
      dueAt: new Date(Date.now() + 86400000),
    });
    return { orderId, noSubmissionOrderId, lateOrderId, d2: d2.id, va: va.id };
  });

  const designer: RequestUser = { id: ctx.d2, role: "designer" };
  const va: RequestUser = { id: ctx.va, role: "va" };
  const t = (actor: RequestUser, to: OrderStatus, from: OrderStatus) =>
    () => transition(actor, { orderId: ctx.orderId, to, expectedFrom: from });

  console.log("=== designer cannot skip QC (crafted requests) ===");
  await expectThrow("designer in_design -> awaiting_approval", ctx.orderId, t(designer, "awaiting_approval", "in_design"), "in_design");
  await expectThrow("designer in_design -> approved", ctx.orderId, t(designer, "approved", "in_design"), "in_design");
  await expectThrow("designer in_design -> complete", ctx.orderId, t(designer, "complete", "in_design"), "in_design");
  await expectThrow("designer in_design -> printing", ctx.orderId, t(designer, "printing", "in_design"), "in_design");

  console.log("=== designer's one legal edge works ===");
  await expectThrow(
    "designer in_design -> awaiting_qc without submission",
    ctx.noSubmissionOrderId,
    () => transition(designer, { orderId: ctx.noSubmissionOrderId, to: "awaiting_qc", expectedFrom: "in_design" }),
    "in_design",
  );
  await addSubmission(ctx.orderId);
  await transition(designer, { orderId: ctx.orderId, to: "awaiting_qc", expectedFrom: "in_design" });
  report("designer in_design -> awaiting_qc", (await statusOf(ctx.orderId)) === "awaiting_qc", `status now ${await statusOf(ctx.orderId)}`);

  console.log("=== designer cannot pass their own QC gate ===");
  await expectThrow("designer awaiting_qc -> awaiting_approval (self-approve)", ctx.orderId, t(designer, "awaiting_approval", "awaiting_qc"), "awaiting_qc");
  await expectThrow("designer awaiting_qc -> in_design (self QC-fail)", ctx.orderId, t(designer, "in_design", "awaiting_qc"), "awaiting_qc");

  console.log("=== optimistic concurrency (stale) ===");
  let stale = false;
  try {
    // VA believes it's still in_design, but it's awaiting_qc now.
    await transition(va, { orderId: ctx.orderId, to: "awaiting_approval", expectedFrom: "in_design" });
  } catch (e) {
    stale = e instanceof StaleTransitionError;
  }
  report("stale expectedFrom is rejected", stale, stale ? "StaleTransitionError thrown" : "no stale error");

  console.log("=== positive control: VA can pass QC ===");
  await transition(va, {
    orderId: ctx.orderId,
    to: "awaiting_approval",
    expectedFrom: "awaiting_qc",
    metadata: { itemResults: passingItemResults },
  });
  report("VA awaiting_qc -> awaiting_approval", (await statusOf(ctx.orderId)) === "awaiting_approval", `status now ${await statusOf(ctx.orderId)}`);

  console.log("=== even after QC, designer cannot approve ===");
  await expectThrow("designer awaiting_approval -> approved", ctx.orderId, t(designer, "approved", "awaiting_approval"), "awaiting_approval");

  console.log("=== VA can create a late revision from completed work ===");
  await transition(va, {
    orderId: ctx.lateOrderId,
    to: "in_design",
    expectedFrom: "complete",
    metadata: { via: "va_created_revision", revisionReason: "Customer emailed a late change." },
  });
  const late = await statusRevisionOf(ctx.lateOrderId);
  report(
    "VA complete -> in_design revision",
    late.status === "in_design" && late.revisionCount === 1,
    `status ${late.status}, revisionCount ${late.revisionCount}`,
  );

  // --- cleanup -------------------------------------------------------------
  await withSystemContext(async (tx) => {
    await tx.delete(orders).where(eq(orders.id, ctx.orderId)); // cascades items/assignments
    await tx.delete(orders).where(eq(orders.id, ctx.noSubmissionOrderId)); // cascades items/assignments
    await tx.delete(orders).where(eq(orders.id, ctx.lateOrderId)); // cascades items/assignments
  });

  console.log(`\n${failures === 0 ? "ALL PASSED" : failures + " FAILED"}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("test-transitions crashed:", e);
  process.exit(1);
});
