/**
 * A person's hand-in is never refused on a check (Yousif 2026-11-11: "don't do
 * any preliminary checks or block anything that the designer wants to submit
 * ... The failed QC should only be after a human checks and then says so").
 * On a real database:
 *   1. a designer hands in a 2-portrait order with one file: it goes to QC with
 *      a heads-up naming portrait 2, logged on the order;
 *   2. the QC pass still stops on the empty portrait (nothing half-done reaches
 *      a customer), so the person on QC is the one who sends it back;
 *   3. the AI Studio's own hand-in (system) still needs a file per portrait;
 *   4. after a QC fail the designer hands the SAME files in again (Mar
 *      #CPS10284): it goes to QC with a heads-up, never "add a new version".
 * Prints PASS/FAIL per assertion; exits non-zero on a fail.
 */
import "./load-env";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";

import { withSystemContext, SYSTEM_ACTOR_ID, type RequestUser } from "../lib/db";
import { activityLog, assets, assignments, designerBusinesses, orderItems, orders, shops, users } from "../lib/db/schema";
import { DEFAULT_CHECKLIST } from "../lib/qc/checklist";
import { HAND_IN_HEADS_UP_ACTION, OrderTransitionError, runTransition, transition } from "../lib/orders/transitions";

let failures = 0;
function report(name: string, pass: boolean, detail: string) {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
  console.log(`      ${detail}`);
  if (!pass) failures += 1;
}

const passingItemResults = Object.fromEntries(DEFAULT_CHECKLIST.map((item) => [item.key, true]));
const statusOf = (orderId: string) =>
  withSystemContext(async (tx) => (await tx.select({ status: orders.status }).from(orders).where(eq(orders.id, orderId)))[0]?.status ?? "(missing)");

async function main() {
  const stamp = Date.now();
  const ctx = await withSystemContext(async (tx) => {
    const [d2] = await tx.select({ id: users.id }).from(users).where(eq(users.email, "d2@aystudios.io"));
    const [va] = await tx.select({ id: users.id, name: users.name }).from(users).where(eq(users.email, "va1@aystudios.io"));
    const [shop] = await tx
      .select({ id: shops.id, businessId: shops.businessId })
      .from(shops)
      .innerJoin(designerBusinesses, eq(designerBusinesses.businessId, shops.businessId))
      .where(and(eq(designerBusinesses.userId, d2.id), eq(shops.platform, "etsy")))
      .limit(1);
    const make = async (label: string) => {
      const id = randomUUID();
      await tx.insert(orders).values({ id, businessId: shop.businessId, shopId: shop.id, platformOrderId: `HU-${label}-${stamp}`, status: "in_design", source: "manual", uploadToken: randomUUID() });
      const [item] = await tx
        .insert(orderItems)
        .values({ businessId: shop.businessId, orderId: id, quantity: 2, figureCount: 1, figureCountSource: "manual", productType: "digital" })
        .returning({ id: orderItems.id });
      await tx.insert(assignments).values({ businessId: shop.businessId, orderId: id, designerId: d2.id, active: true, dueAt: new Date(Date.now() + 86400000) });
      // portrait 1 only: portrait 2 has no file
      await tx.insert(assets).values({ businessId: shop.businessId, orderId: id, type: "submission", storage: "cdn", url: `https://example.com/${id}-1.jpg`, uploadedBy: d2.id, orderItemId: item.id, portraitUnit: 1, width: 4800, height: 6000 });
      return id;
    };
    return { d2: d2.id, va: va.id, vaName: va.name, person: await make("PERSON"), studio: await make("STUDIO") };
  });
  const designer: RequestUser = { id: ctx.d2, role: "designer" };
  const va: RequestUser = { id: ctx.va, role: "va" };

  try {
    console.log("=== 1. a designer's hand-in with an empty portrait goes to QC with a heads-up ===");
    let refused = "";
    let warnings = "";
    try {
      const res = await transition(designer, { orderId: ctx.person, to: "awaiting_qc", expectedFrom: "in_design" });
      warnings = res.warnings?.join(" ") ?? "";
    } catch (e) {
      if (e instanceof OrderTransitionError) refused = e.message;
      else throw e;
    }
    report("the hand-in is not refused", !refused && (await statusOf(ctx.person)) === "awaiting_qc", refused || `status ${await statusOf(ctx.person)}`);
    report("the designer is told which portrait has no file", /Portrait 2 of 2 has no file yet\. It went to QC as it is/.test(warnings), warnings || "(no heads-up)");
    const logged = await withSystemContext((tx) =>
      tx.select({ metadata: activityLog.metadata }).from(activityLog).where(and(eq(activityLog.orderId, ctx.person), eq(activityLog.action, HAND_IN_HEADS_UP_ACTION))),
    );
    const kinds = ((logged[0]?.metadata ?? {}) as { kinds?: string[] }).kinds ?? [];
    report("the heads-up is on the order's history for QC", logged.length === 1 && kinds.includes("missing_portrait"), `${logged.length} row(s), kinds ${kinds.join(",")}`);

    console.log("=== 2. the QC pass still stops: the person on QC sends it back ===");
    let stop = "";
    try {
      await transition(va, { orderId: ctx.person, to: "awaiting_approval", expectedFrom: "awaiting_qc", metadata: { itemResults: passingItemResults, signature: ctx.vaName } });
    } catch (e) {
      if (e instanceof OrderTransitionError) stop = e.message;
      else throw e;
    }
    report("a pass with an empty portrait is refused", /portrait 2 of 2 has no file yet/i.test(stop) && (await statusOf(ctx.person)) === "awaiting_qc", stop || "(passed!)");

    console.log("=== 3. the AI Studio's own hand-in still needs every portrait ===");
    let gate = "";
    try {
      await withSystemContext((tx) => runTransition(tx, { id: SYSTEM_ACTOR_ID, role: "system" }, { orderId: ctx.studio, to: "awaiting_qc", expectedFrom: "in_design" }));
    } catch (e) {
      gate = (e as Error).message;
    }
    report("system hand-in refused while portrait 2 has no file", /Portrait 2 of 2 has no file yet/.test(gate) && (await statusOf(ctx.studio)) === "in_design", gate || "(went through)");

    console.log("=== 4. sent back, then handed in again with the same files ===");
    const failingItemResults = { ...passingItemResults, [DEFAULT_CHECKLIST[0].key]: false };
    await transition(va, { orderId: ctx.person, to: "in_design", expectedFrom: "awaiting_qc", metadata: { itemResults: failingItemResults, signature: ctx.vaName, reason: "Only one background supplied." } });
    let again = "";
    let againWarnings = "";
    try {
      const res = await transition(designer, { orderId: ctx.person, to: "awaiting_qc", expectedFrom: "in_design" });
      againWarnings = res.warnings?.join(" ") ?? "";
    } catch (e) {
      if (e instanceof OrderTransitionError) again = e.message;
      else throw e;
    }
    report("the same files go back to QC, not refused", !again && (await statusOf(ctx.person)) === "awaiting_qc", again || `status ${await statusOf(ctx.person)}`);
    report("the designer is told no new version was added", /No new version was added since this order was sent back/.test(againWarnings), againWarnings || "(no heads-up)");
  } finally {
    await withSystemContext(async (tx) => {
      await tx.delete(orders).where(inArray(orders.id, [ctx.person, ctx.studio]));
    });
  }

  console.log(`\n${failures === 0 ? "ALL PASSED" : failures + " FAILED"}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("test-hand-in-heads-up crashed:", e);
  process.exit(1);
});
