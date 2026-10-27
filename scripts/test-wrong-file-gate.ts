/**
 * The wrong-file stop on a real database (2026-10-27, Jerome: Alyssa's portrait
 * 4213333468 was also put on Erin's 4204560873 by mistake, and the RIGHT order
 * could not be handed in). Proves:
 *   1. a designer hands in a picture that is also on another order where it has
 *      not gone out: it goes through with a heads-up naming that order, logged;
 *   2. QC pass still stops on it until staff give a reason;
 *   3. once that order's picture went to its customer, the same picture on yet
 *      another order is refused for the designer;
 *   4. a copy replaced before it went out is a stray and stops counting.
 * Prints PASS/FAIL per assertion; exits non-zero on a fail.
 */
import "./load-env";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";

import { withSystemContext, type RequestUser } from "../lib/db";
import { activityLog, assets, assignments, designerBusinesses, orderItems, orders, shops, users } from "../lib/db/schema";
import { DEFAULT_CHECKLIST } from "../lib/qc/checklist";
import { FINE_H, FINE_W, fineSigFromGray } from "../lib/qc/image-hash";
import { WRONG_FILE_HEADS_UP_ACTION } from "../lib/qc/wrong-file";
import { OrderTransitionError, transition, type OrderStatus } from "../lib/orders/transitions";

let failures = 0;
function report(name: string, pass: boolean, detail: string) {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
  console.log(`      ${detail}`);
  if (!pass) failures += 1;
}

/** A 64x80 drawing: cream paper with a dark block placed by `seed` (different seeds = different pictures). */
function picture(seed: number): { dhash: string; fineSig: string } {
  const px = new Uint8Array(FINE_W * FINE_H).fill(232);
  const x0 = 8 + ((seed * 13) % 30);
  const y0 = 8 + ((seed * 29) % 40);
  for (let y = y0; y < y0 + 30; y++) for (let x = x0; x < x0 + 24; x++) px[y * FINE_W + x] = 60;
  // dHash is only the first look; the ink decides. Different seeds keep their dHashes apart too.
  const dhash = (seed * 0x1f3a5c7e9b).toString(16).padStart(16, "0").slice(-16);
  return { dhash, fineSig: fineSigFromGray(px) };
}

const passingItemResults = Object.fromEntries(DEFAULT_CHECKLIST.map((item) => [item.key, true]));

async function statusOf(orderId: string): Promise<string> {
  return withSystemContext(async (tx) => {
    const [o] = await tx.select({ status: orders.status }).from(orders).where(eq(orders.id, orderId));
    return o?.status ?? "(missing)";
  });
}

async function main() {
  const stamp = Date.now();
  const P = picture(3);
  const Q = picture(5);
  const R = picture(7);

  const ctx = await withSystemContext(async (tx) => {
    const [d2] = await tx.select({ id: users.id }).from(users).where(eq(users.email, "d2@aystudios.io"));
    const [va] = await tx.select({ id: users.id, name: users.name }).from(users).where(eq(users.email, "va1@aystudios.io"));
    const [shop] = await tx
      .select({ id: shops.id, businessId: shops.businessId })
      .from(shops)
      .innerJoin(designerBusinesses, eq(designerBusinesses.businessId, shops.businessId))
      .where(and(eq(designerBusinesses.userId, d2.id), eq(shops.platform, "etsy")))
      .limit(1);
    const make = async (label: string, status: OrderStatus) => {
      const id = randomUUID();
      await tx.insert(orders).values({
        id,
        businessId: shop.businessId,
        shopId: shop.id,
        platformOrderId: `WF-${label}-${stamp}`,
        status,
        source: "manual",
        uploadToken: randomUUID(),
      });
      await tx.insert(orderItems).values({ businessId: shop.businessId, orderId: id, figureCount: 1, figureCountSource: "manual", productType: "digital" });
      await tx.insert(assignments).values({ businessId: shop.businessId, orderId: id, designerId: d2.id, active: true, dueAt: new Date(Date.now() + 86400000) });
      return id;
    };
    const ids = {
      alyssa: await make("ALYSSA", "in_design"),
      erin: await make("ERIN", "in_design"),
      third: await make("THIRD", "in_design"),
      fourth: await make("FOURTH", "in_design"),
    };
    const file = async (orderId: string, pic: { dhash: string; fineSig: string }, by: string | null) => {
      const [a] = await tx
        .insert(assets)
        .values({
          businessId: shop.businessId,
          orderId,
          type: "submission",
          storage: "cdn",
          url: `https://example.com/${orderId}-${randomUUID()}.jpg`,
          uploadedBy: by,
          dhash: pic.dhash,
          fineSig: pic.fineSig,
          width: 4800,
          height: 6000,
        })
        .returning({ id: assets.id });
      return a.id;
    };
    // The mix-up: the same picture on Erin's order first, then on Alyssa's.
    const stray = await file(ids.erin, P, d2.id);
    await file(ids.alyssa, P, d2.id);
    return { ...ids, stray, d2: d2.id, va: va.id, vaName: va.name ?? "", businessId: shop.businessId };
  });

  const addFile = (orderId: string, pic: { dhash: string; fineSig: string }) =>
    withSystemContext(async (tx) => {
      await tx.insert(assets).values({
        businessId: ctx.businessId,
        orderId,
        type: "submission",
        storage: "cdn",
        url: `https://example.com/${orderId}-${randomUUID()}.jpg`,
        uploadedBy: ctx.d2,
        dhash: pic.dhash,
        fineSig: pic.fineSig,
        width: 4800,
        height: 6000,
      });
    });

  const designer: RequestUser = { id: ctx.d2, role: "designer" };
  const va: RequestUser = { id: ctx.va, role: "va" };
  const num = (label: string) => `WF-${label}-${stamp}`;

  try {
    console.log("=== 1. the right order goes in, with a heads-up naming the other ===");
    const res = await transition(designer, { orderId: ctx.alyssa, to: "awaiting_qc", expectedFrom: "in_design" });
    report(
      "designer hands in a picture that is also on an unsent order",
      res.status === "awaiting_qc" && (await statusOf(ctx.alyssa)) === "awaiting_qc",
      `status ${await statusOf(ctx.alyssa)}`,
    );
    const note = res.warnings?.join(" ") ?? "";
    report("the heads-up names the other order", note.includes(num("ERIN")), note || "(no heads-up)");
    const logged = await withSystemContext((tx) =>
      tx.select({ id: activityLog.id }).from(activityLog).where(and(eq(activityLog.orderId, ctx.alyssa), eq(activityLog.action, WRONG_FILE_HEADS_UP_ACTION))),
    );
    report("the heads-up is on the order's history for QC", logged.length === 1, `${logged.length} row(s)`);

    console.log("=== 2. QC pass still stops on it until staff give a reason ===");
    const pass = (overrideReason?: string) =>
      transition(va, {
        orderId: ctx.alyssa,
        to: "awaiting_approval",
        expectedFrom: "awaiting_qc",
        metadata: { itemResults: passingItemResults, signature: ctx.vaName },
        overrideReason,
      });
    let stopped: OrderTransitionError | null = null;
    try {
      await pass();
    } catch (e) {
      if (e instanceof OrderTransitionError) stopped = e;
      else throw e;
    }
    report(
      "QC pass without a reason is stopped",
      !!stopped && /has not gone to the customer yet/.test(stopped.message) && (await statusOf(ctx.alyssa)) === "awaiting_qc",
      stopped ? stopped.message : "NOT stopped",
    );
    await pass("checked: this is Alyssa's");
    report("QC pass with a reason goes through", (await statusOf(ctx.alyssa)) === "awaiting_approval", `status ${await statusOf(ctx.alyssa)}`);

    console.log("=== 3. the picture went out on Alyssa's: on any other order it is refused ===");
    await addFile(ctx.third, P);
    let refused: OrderTransitionError | null = null;
    try {
      await transition(designer, { orderId: ctx.third, to: "awaiting_qc", expectedFrom: "in_design" });
    } catch (e) {
      if (e instanceof OrderTransitionError) refused = e;
      else throw e;
    }
    report(
      "designer hand-in of a picture already sent on another order is refused",
      !!refused && /Upload the right file for this order/.test(refused.message) && (await statusOf(ctx.third)) === "in_design",
      refused ? refused.message : "NOT refused",
    );
    // Erin's order still carries it too: refused the same way until her own art is up.
    let erinRefused = false;
    try {
      await transition(designer, { orderId: ctx.erin, to: "awaiting_qc", expectedFrom: "in_design" });
    } catch (e) {
      erinRefused = e instanceof OrderTransitionError;
    }
    report("the order with the mix-up stays refused", erinRefused && (await statusOf(ctx.erin)) === "in_design", `status ${await statusOf(ctx.erin)}`);

    console.log("=== 4. Erin's own picture replaces the stray: it stops counting ===");
    await addFile(ctx.erin, Q);
    const erin = await transition(designer, { orderId: ctx.erin, to: "awaiting_qc", expectedFrom: "in_design" });
    report("Erin's order goes in with her own picture", erin.status === "awaiting_qc" && !erin.warnings, `status ${erin.status}, heads-up ${erin.warnings?.join(" ") ?? "none"}`);
    // A different order with a picture nobody else has: no heads-up, nothing stops.
    await addFile(ctx.fourth, R);
    const fourth = await transition(designer, { orderId: ctx.fourth, to: "awaiting_qc", expectedFrom: "in_design" });
    report("an unrelated picture goes in quietly", fourth.status === "awaiting_qc" && !fourth.warnings, `status ${fourth.status}`);
  } finally {
    await withSystemContext(async (tx) => {
      await tx.delete(orders).where(inArray(orders.id, [ctx.alyssa, ctx.erin, ctx.third, ctx.fourth]));
    });
  }

  console.log(`\n${failures === 0 ? "ALL PASSED" : failures + " FAILED"}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("test-wrong-file-gate crashed:", e);
  process.exit(1);
});
