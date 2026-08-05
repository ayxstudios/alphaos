/**
 * Proves manual↔import reconciliation (Case 2): when a VA created an order before
 * the platform imports it, the import PROMOTES the manual row in place — never a
 * duplicate — and fills only blanks; the VA's figure count / style / notes /
 * photos / customer always win. Also proves the match normalises whitespace,
 * leading '#', and case. Prints PASS/FAIL; exits non-zero on any failure.
 */
import "./load-env";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";

import { withSystemContext } from "../lib/db";
import { shops, businesses, orders, orderItems, assets, customers } from "../lib/db/schema";
import { reconcileManualOrder } from "../lib/orders/reconcile";

let failures = 0;
function report(name: string, pass: boolean, detail: string) {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
  console.log(`      ${detail}`);
  if (!pass) failures += 1;
}

async function makeCustomer(businessId: string, email: string): Promise<string> {
  return withSystemContext(async (tx) => {
    await tx.insert(customers).values({ businessId, email, firstName: "Test" }).onConflictDoNothing({ target: [customers.businessId, customers.email] });
    const [c] = await tx.select({ id: customers.id }).from(customers).where(and(eq(customers.businessId, businessId), eq(customers.email, email)));
    return c.id;
  });
}

async function makeManualOrder(opts: {
  businessId: string; shopId: string; number: string; customerId: string | null; withPhoto: boolean;
}): Promise<string> {
  const orderId = randomUUID();
  await withSystemContext(async (tx) => {
    await tx.insert(orders).values({
      id: orderId,
      businessId: opts.businessId,
      shopId: opts.shopId,
      customerId: opts.customerId,
      platformOrderId: `manual:${opts.number.toLowerCase()}`,
      platformOrderName: opts.number,
      status: "ready_to_assign",
      source: "manual",
      uploadToken: randomUUID(),
      needsReview: false,
      notes: "VA notes",
    });
    await tx.insert(orderItems).values({
      businessId: opts.businessId, orderId, figureCount: 3, figureCountSource: "manual", style: "Watercolor", productType: "physical",
    });
    if (opts.withPhoto) {
      await tx.insert(assets).values({ businessId: opts.businessId, orderId, type: "reference", storage: "cdn", url: "https://example.com/va-photo.jpg" });
    }
  });
  return orderId;
}

async function main() {
  const { shopId, businessId } = await withSystemContext(async (tx) => {
    const [s] = await tx.select({ id: shops.id, businessId: shops.businessId }).from(shops).innerJoin(businesses, eq(businesses.id, shops.businessId)).limit(1);
    if (!s) throw new Error("no shop in DB — run the seed first");
    return { shopId: s.id, businessId: s.businessId };
  });
  const custA = await makeCustomer(businessId, `a-${Date.now()}@test.io`);
  const custB = await makeCustomer(businessId, `b-${Date.now()}@test.io`);

  // --- Scenario 1: manual order has NO customer + a photo already ------------
  const num1 = `RECON-${Date.now()}`;
  const receiptId1 = String(Date.now()); // Etsy's real numeric id
  const id1 = await makeManualOrder({ businessId, shopId, number: num1, customerId: null, withPhoto: true });

  const rec1 = await withSystemContext((tx) =>
    reconcileManualOrder(tx, {
      shopId, businessId,
      realPlatformOrderId: receiptId1,
      orderNumber: `  #${num1.toLowerCase()} `, // whitespace + '#' + case — must still match
      customerId: custB,
      photoUrls: ["https://example.com/import-photo.jpg"],
      rawImport: { receipt_id: receiptId1, note_from_buyer: "2 cats please" },
    }),
  );
  report("s1: reconciled onto the manual row (normalised match)", rec1.reconciled && rec1.orderId === id1, `reconciled=${rec1.reconciled} orderId=${rec1.orderId}`);

  const s1 = await withSystemContext(async (tx) => {
    const [o] = await tx.select({ pid: orders.platformOrderId, status: orders.status, notes: orders.notes, customerId: orders.customerId, raw: orders.rawImport }).from(orders).where(eq(orders.id, id1));
    const [it] = await tx.select({ figureCount: orderItems.figureCount, style: orderItems.style }).from(orderItems).where(eq(orderItems.orderId, id1));
    const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(assets).where(and(eq(assets.orderId, id1), eq(assets.type, "reference")));
    const [{ n: dupN }] = await tx.select({ n: sql<number>`count(*)::int` }).from(orders).where(and(eq(orders.shopId, shopId), sql`lower(${orders.platformOrderName}) = ${num1.toLowerCase()}`));
    return { o, it, refCount: n, dupN };
  });
  report("s1: no duplicate order created", s1.dupN === 1, `orders with that number: ${s1.dupN}`);
  report("s1: promoted to the real platform id", s1.o.pid === receiptId1, `platform_order_id=${s1.o.pid}`);
  report("s1: VA data preserved (figures/style/notes/status)", s1.it.figureCount === 3 && s1.it.style === "Watercolor" && s1.o.notes === "VA notes" && s1.o.status === "ready_to_assign", `figures=${s1.it.figureCount} style=${s1.it.style} notes="${s1.o.notes}" status=${s1.o.status}`);
  report("s1: import photo NOT added (VA already had one)", s1.refCount === 1, `reference assets: ${s1.refCount}`);
  report("s1: blank customer filled from import", s1.o.customerId === custB, `customerId=${s1.o.customerId === custB ? "importB" : s1.o.customerId}`);
  report("s1: blank raw_import filled from import", !!s1.o.raw, `raw_import set: ${!!s1.o.raw}`);

  // --- Scenario 2: manual order HAS a customer + NO photo --------------------
  const num2 = `RECON2-${Date.now()}`;
  const receiptId2 = String(Date.now() + 1);
  const id2 = await makeManualOrder({ businessId, shopId, number: num2, customerId: custA, withPhoto: false });

  await withSystemContext((tx) =>
    reconcileManualOrder(tx, {
      shopId, businessId,
      realPlatformOrderId: receiptId2,
      orderNumber: num2,
      customerId: custB, // must NOT overwrite the VA's custA
      photoUrls: ["https://example.com/import-photo.jpg"], // manual had none -> should be added
      rawImport: { receipt_id: receiptId2 },
    }),
  );
  const s2 = await withSystemContext(async (tx) => {
    const [o] = await tx.select({ customerId: orders.customerId }).from(orders).where(eq(orders.id, id2));
    const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(assets).where(and(eq(assets.orderId, id2), eq(assets.type, "reference")));
    return { customerId: o.customerId, refCount: n };
  });
  report("s2: existing customer NOT overwritten by import", s2.customerId === custA, `customerId=${s2.customerId === custA ? "vaA (kept)" : "OVERWRITTEN"}`);
  report("s2: import photo added when VA had none", s2.refCount === 1, `reference assets: ${s2.refCount}`);

  // cleanup (orders cascade items/assets)
  await withSystemContext(async (tx) => {
    await tx.delete(orders).where(eq(orders.id, id1));
    await tx.delete(orders).where(eq(orders.id, id2));
  });

  console.log(`\n${failures === 0 ? "ALL PASSED" : failures + " FAILED"}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("test-reconcile crashed:", e);
  process.exit(1);
});
