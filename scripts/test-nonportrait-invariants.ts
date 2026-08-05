/**
 * Proves the invariants the `fulfillment_only` state exists to guarantee: a
 * non-portrait order can NEVER reach a designer (in_design), a proof
 * (awaiting_approval), or mint an earnings row — by any path, including crafted
 * requests straight to transition(). Same adversarial style as
 * test-transitions.ts. Even with an active assignment planted on the order (the
 * worst case), completing it must pay nobody.
 *
 * Prints PASS/FAIL per assertion; exits non-zero on any failure.
 */
import "./load-env";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

import { withSystemContext, type RequestUser } from "../lib/db";
import { orders, orderItems, assignments, earnings, proofs, users, shops } from "../lib/db/schema";
import { transition, OrderTransitionError, type OrderStatus } from "../lib/orders/transitions";

let failures = 0;
function report(name: string, pass: boolean, detail: string) {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
  console.log(`      ${detail}`);
  if (!pass) failures += 1;
}

async function statusOf(orderId: string): Promise<string> {
  return withSystemContext(async (tx) => {
    const [o] = await tx.select({ status: orders.status }).from(orders).where(eq(orders.id, orderId));
    return o?.status ?? "(missing)";
  });
}

async function expectThrow(name: string, orderId: string, fn: () => Promise<unknown>, mustStayAt: string) {
  let threw: OrderTransitionError | null = null;
  try {
    await fn();
  } catch (e) {
    if (e instanceof OrderTransitionError) threw = e;
    else throw e;
  }
  const status = await statusOf(orderId);
  report(
    name,
    !!threw && status === mustStayAt,
    threw ? `rejected (${threw.code}); status still ${status}` : `NOT rejected; status ${status}`,
  );
}

async function main() {
  const ctx = await withSystemContext(async (tx) => {
    const [shop] = await tx.select({ id: shops.id, businessId: shops.businessId }).from(shops).limit(1);
    if (!shop) throw new Error("no shop in DB — run the seed first");
    const [va] = await tx.select({ id: users.id }).from(users).where(eq(users.role, "va")).limit(1);
    const [designer] = await tx.select({ id: users.id }).from(users).where(eq(users.role, "designer")).limit(1);
    if (!va || !designer) throw new Error("need a va and a designer in DB");

    const orderId = randomUUID();
    await tx.insert(orders).values({
      id: orderId,
      businessId: shop.businessId,
      shopId: shop.id,
      platformOrderId: `NPTEST-${Date.now()}`,
      status: "fulfillment_only",
      source: "shopify",
      uploadToken: randomUUID(),
    });
    // A resolved figure count + an ACTIVE assignment: the adversarial worst case
    // where, if the earnings gate were wrong, a payout WOULD be minted.
    await tx.insert(orderItems).values({
      businessId: shop.businessId,
      orderId,
      figureCount: 2,
      figureCountSource: "manual",
      productType: "physical",
    });
    await tx.insert(assignments).values({
      businessId: shop.businessId,
      orderId,
      designerId: designer.id,
      active: true,
      dueAt: new Date(Date.now() + 86400000),
    });
    return { orderId, va: va.id };
  });

  const va: RequestUser = { id: ctx.va, role: "va" };
  const t = (to: OrderStatus, from: OrderStatus) => () => transition(va, { orderId: ctx.orderId, to, expectedFrom: from });

  console.log("=== fulfillment_only cannot reach design, QC, proof, or approval ===");
  await expectThrow("fulfillment_only -> in_design", ctx.orderId, t("in_design", "fulfillment_only"), "fulfillment_only");
  await expectThrow("fulfillment_only -> ready_to_assign", ctx.orderId, t("ready_to_assign", "fulfillment_only"), "fulfillment_only");
  await expectThrow("fulfillment_only -> awaiting_qc", ctx.orderId, t("awaiting_qc", "fulfillment_only"), "fulfillment_only");
  await expectThrow("fulfillment_only -> awaiting_approval", ctx.orderId, t("awaiting_approval", "fulfillment_only"), "fulfillment_only");
  await expectThrow("fulfillment_only -> approved", ctx.orderId, t("approved", "fulfillment_only"), "fulfillment_only");

  console.log("=== completing a fulfillment_only order pays nobody ===");
  await transition(va, { orderId: ctx.orderId, to: "complete", expectedFrom: "fulfillment_only" });
  report("fulfillment_only -> complete is legal", (await statusOf(ctx.orderId)) === "complete", `status now ${await statusOf(ctx.orderId)}`);

  const { earningRows, proofRows } = await withSystemContext(async (tx) => {
    const e = await tx.select({ id: earnings.id }).from(earnings).where(eq(earnings.orderId, ctx.orderId));
    const p = await tx.select({ id: proofs.id }).from(proofs).where(eq(proofs.orderId, ctx.orderId));
    return { earningRows: e.length, proofRows: p.length };
  });
  report("no earnings row was created", earningRows === 0, `earnings rows for order: ${earningRows}`);
  report("no proof was ever created", proofRows === 0, `proof rows for order: ${proofRows}`);

  // cleanup
  await withSystemContext(async (tx) => {
    await tx.delete(earnings).where(eq(earnings.orderId, ctx.orderId));
    await tx.delete(orders).where(eq(orders.id, ctx.orderId)); // cascades items/assignments/proofs
  });

  console.log(`\n${failures === 0 ? "ALL PASSED" : failures + " FAILED"}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("test-nonportrait-invariants crashed:", e);
  process.exit(1);
});
