/**
 * Proves the order state machine's role gate: a DESIGNER cannot self-approve or
 * otherwise advance an order past QC by any path (including a crafted request
 * straight to transition()). Also checks optimistic-concurrency (stale) and a
 * staff positive control. Also proves that a customer revision on an ARCHIVED
 * legacy order revives it (flag cleared, items rebuilt from the Etsy receipt,
 * one order.unarchived activity row, all in the revision's own transaction).
 * Prints PASS/FAIL per assertion; exits non-zero on fail. Staging database only.
 */
import "./load-env";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";

import { withSystemContext, type RequestUser, type Tx } from "../lib/db";
import { orders, orderItems, assignments, users, shops, designerBusinesses, assets, activityLog } from "../lib/db/schema";
import { DEFAULT_CHECKLIST } from "../lib/qc/checklist";
import { liveOrderWhere, reviveArchivedOrder } from "../lib/orders/archive";
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

async function firstUser(tx: Tx, emails: string[]): Promise<{ id: string; name: string | null }> {
  for (const email of emails) {
    const [user] = await tx.select({ id: users.id, name: users.name }).from(users).where(eq(users.email, email));
    if (user) return user;
  }
  throw new Error(`No test user found (tried ${emails.join(", ")})`);
}

// --- archived-order fixtures ------------------------------------------------
const ARCHIVE_REASON = "Imported before shop backfill cutoff";

// An old Etsy order as the importer stored it in orders.raw_import: one download
// line and one printed line, each with the buyer's chosen options.
const archivedReceipt = {
  receipt_id: 4196536586,
  name: "Archive Test Buyer",
  buyer_email: "archive-test@example.com",
  transactions: [
    {
      transaction_id: 1,
      title: "Custom Pet Portrait Digital Download",
      sku: "PET-DIGITAL",
      quantity: 1,
      is_digital: true,
      variations: [{ formatted_name: "Style", formatted_value: "Watercolor" }],
    },
    {
      transaction_id: 2,
      title: "Custom Cartoon Pet Portrait",
      sku: null,
      quantity: 1,
      is_digital: false,
      variations: [
        { formatted_name: "Size", formatted_value: "8x10" },
        { formatted_name: "Personalization:", formatted_value: "Ammut" },
      ],
    },
  ],
};

type SeedOptions = {
  status: OrderStatus;
  source: "etsy" | "legacy";
  archived: boolean;
  rawImport: unknown;
  /** Item rows the order already has (figure count 3, set by a person). */
  itemRows?: number;
};

async function seedOrder(base: { businessId: string; shopId: string }, tag: string, opts: SeedOptions): Promise<string> {
  const id = randomUUID();
  await withSystemContext(async (tx) => {
    await tx.insert(orders).values({
      id,
      businessId: base.businessId,
      shopId: base.shopId,
      platformOrderId: `ARCH-${tag}-${Date.now()}`,
      platformOrderName: `ARCH-${tag}`,
      status: opts.status,
      source: opts.source,
      rawImport: opts.rawImport,
      archivedAt: opts.archived ? new Date("2026-10-11T00:00:00.000Z") : null,
      archiveReason: opts.archived ? ARCHIVE_REASON : null,
      uploadToken: randomUUID(),
    });
    for (let i = 0; i < (opts.itemRows ?? 0); i++) {
      await tx.insert(orderItems).values({
        businessId: base.businessId,
        orderId: id,
        figureCount: 3,
        figureCountSource: "manual",
        productType: "digital",
      });
    }
  });
  return id;
}

async function archiveStateOf(orderId: string) {
  return withSystemContext(async (tx) => {
    const [o] = await tx
      .select({
        status: orders.status,
        revisionCount: orders.revisionCount,
        archivedAt: orders.archivedAt,
        archiveReason: orders.archiveReason,
      })
      .from(orders)
      .where(eq(orders.id, orderId));
    const items = await tx
      .select({
        sku: orderItems.sku,
        title: orderItems.title,
        options: orderItems.options,
        productType: orderItems.productType,
        figureCount: orderItems.figureCount,
      })
      .from(orderItems)
      .where(eq(orderItems.orderId, orderId));
    return {
      status: o?.status ?? "(missing)",
      revisionCount: o?.revisionCount ?? -1,
      archivedAt: o?.archivedAt ?? null,
      archiveReason: o?.archiveReason ?? null,
      items,
    };
  });
}

async function activityOf(orderId: string, action: string) {
  return withSystemContext((tx) =>
    tx
      .select({ actorId: activityLog.actorId, metadata: activityLog.metadata })
      .from(activityLog)
      .where(and(eq(activityLog.orderId, orderId), eq(activityLog.action, action))),
  );
}

/** The ids, out of `ids`, that the live lists (liveOrderWhere) would show. */
async function liveIdsOf(ids: string[]): Promise<string[]> {
  return withSystemContext(async (tx) =>
    (await tx.select({ id: orders.id }).from(orders).where(and(inArray(orders.id, ids), liveOrderWhere()))).map((r) => r.id),
  );
}

async function main() {
  // --- setup: a resolved in_design order assigned to designer d2 -----------
  const ctx = await withSystemContext(async (tx) => {
    // The seed users of the local CI database, or the staging logins on staging.
    const d2 = await firstUser(tx, ["d2@aystudios.io", "staging-designer@alphaos.test"]);
    const va = await firstUser(tx, ["va1@aystudios.io", "staging-va@alphaos.test"]);
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
    return {
      orderId,
      noSubmissionOrderId,
      lateOrderId,
      d2: d2.id,
      va: va.id,
      vaName: va.name ?? "",
      businessId: shop.businessId,
      shopId: shop.id,
    };
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
    // QC sign-off (0035): the reviewer types their own account name.
    metadata: { itemResults: passingItemResults, signature: ctx.vaName },
  });
  report("VA awaiting_qc -> awaiting_approval", (await statusOf(ctx.orderId)) === "awaiting_approval", `status now ${await statusOf(ctx.orderId)}`);

  console.log("=== even after QC, designer cannot approve ===");
  await expectThrow("designer awaiting_approval -> approved", ctx.orderId, t(designer, "approved", "awaiting_approval"), "awaiting_approval");

  console.log("=== VA can create a late revision from completed work ===");
  await addSubmission(ctx.lateOrderId); // the version the customer already had
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

  console.log("=== a revision needs a NEW version before it goes back to QC ===");
  await expectThrow(
    "resubmit after a revision with only the old version",
    ctx.lateOrderId,
    () => transition(va, { orderId: ctx.lateOrderId, to: "awaiting_qc", expectedFrom: "in_design" }),
    "in_design",
  );
  await addSubmission(ctx.lateOrderId);
  await transition(va, { orderId: ctx.lateOrderId, to: "awaiting_qc", expectedFrom: "in_design" });
  report(
    "resubmit after a revision with a new version",
    (await statusOf(ctx.lateOrderId)) === "awaiting_qc",
    `status now ${await statusOf(ctx.lateOrderId)}`,
  );

  // --- a customer revision on an archived legacy order -----------------------
  // Archived orders (old platform orders imported before a shop's backfill
  // cutoff) are out of every live list, and the old process left them without
  // order_items. A revision must make one live work again, in its own transaction.
  console.log("=== a revision on an ARCHIVED legacy order brings it back ===");
  const base = { businessId: ctx.businessId, shopId: ctx.shopId };
  const seeded: string[] = [];
  const seed = async (tag: string, opts: SeedOptions) => {
    const id = await seedOrder(base, tag, opts);
    seeded.push(id);
    return id;
  };
  const stubImport = { name: "Archive Test Buyer", buyer_email: "archive-test@example.com" };
  const revisionNote = { via: "va_created_revision", revisionReason: "Customer emailed a change." };
  const reviseAsVa = (orderId: string, metadata: Record<string, unknown> = revisionNote) =>
    transition(va, { orderId, to: "in_design", expectedFrom: "complete", metadata });
  const itemsCreatedOf = (rows: { metadata: unknown }[]) => (rows[0]?.metadata as { itemsCreated?: number } | undefined)?.itemsCreated;

  try {
    const archivedEtsy = await seed("etsy", { status: "complete", source: "etsy", archived: true, rawImport: archivedReceipt });
    const archivedWithItems = await seed("items", { status: "complete", source: "etsy", archived: true, rawImport: archivedReceipt, itemRows: 1 });
    const archivedStub = await seed("stub", { status: "complete", source: "legacy", archived: true, rawImport: stubImport });
    const liveControl = await seed("live", { status: "complete", source: "etsy", archived: false, rawImport: archivedReceipt });
    const archivedShipped = await seed("shipped", { status: "shipped", source: "etsy", archived: true, rawImport: archivedReceipt });
    const archivedPoisoned = await seed("poisoned", { status: "complete", source: "etsy", archived: true, rawImport: archivedReceipt });
    const archivedDirect = await seed("direct", { status: "complete", source: "etsy", archived: true, rawImport: archivedReceipt });

    const liveBefore = await liveIdsOf(seeded);
    report(
      "before a revision only the control order is in the live lists",
      liveBefore.length === 1 && liveBefore[0] === liveControl,
      `${liveBefore.length} of ${seeded.length} seeded orders are live`,
    );

    // The Etsy order with a receipt and no items: the incident.
    await reviseAsVa(archivedEtsy);
    const revived = await archiveStateOf(archivedEtsy);
    report(
      "VA complete -> in_design on an archived order revives it",
      revived.status === "in_design" && revived.revisionCount === 1 && revived.archivedAt === null && revived.archiveReason === null,
      `status ${revived.status}, revisionCount ${revived.revisionCount}, archivedAt ${revived.archivedAt ? "still set" : "cleared"}, archiveReason ${revived.archiveReason ?? "cleared"}`,
    );
    const digital = revived.items.find((i) => i.sku === "PET-DIGITAL");
    const printed = revived.items.find((i) => i.title === "Custom Cartoon Pet Portrait");
    report(
      "its items are built from the Etsy receipt, figure count left for a VA",
      revived.items.length === 2 &&
        digital?.productType === "digital" &&
        JSON.stringify(digital.options) === JSON.stringify([{ name: "Style", value: "Watercolor" }]) &&
        printed?.productType === "physical" &&
        JSON.stringify(printed.options) === JSON.stringify([{ name: "Size", value: "8x10" }, { name: "Personalization", value: "Ammut" }]) &&
        revived.items.every((i) => i.figureCount === null),
      `${revived.items.length} rows; figure counts ${revived.items.map((i) => String(i.figureCount)).join(", ") || "none"}`,
    );
    const unarchivedRows = await activityOf(archivedEtsy, "order.unarchived");
    const unarchivedMeta = unarchivedRows[0]?.metadata as { reason?: string; itemsCreated?: number } | undefined;
    report(
      "one order.unarchived activity row: reason revision, 2 items, by the VA",
      unarchivedRows.length === 1 &&
        unarchivedMeta?.reason === "revision" &&
        unarchivedMeta.itemsCreated === 2 &&
        unarchivedRows[0].actorId === ctx.va,
      `${unarchivedRows.length} row(s), metadata ${JSON.stringify(unarchivedMeta ?? null)}`,
    );
    const inDesignRows = await activityOf(archivedEtsy, "order.in_design");
    report("the revision itself is still logged once", inDesignRows.length === 1, `${inDesignRows.length} order.in_design row(s)`);
    const liveAfter = await liveIdsOf([archivedEtsy]);
    report("the revived order is back in the live lists", liveAfter.length === 1, `${liveAfter.length} of 1 live`);
    const again = await withSystemContext((tx) =>
      reviveArchivedOrder(tx, { orderId: archivedEtsy, businessId: ctx.businessId, actorId: ctx.va, reason: "revision" }),
    );
    const afterAgain = await archiveStateOf(archivedEtsy);
    const rowsAgain = await activityOf(archivedEtsy, "order.unarchived");
    report(
      "reviving an order that is already live does nothing",
      !again.revived && afterAgain.items.length === 2 && rowsAgain.length === 1,
      `revived ${again.revived}, ${afterAgain.items.length} item rows, ${rowsAgain.length} order.unarchived row(s)`,
    );

    // An archived order a person already filled in keeps its items.
    await reviseAsVa(archivedWithItems);
    const kept = await archiveStateOf(archivedWithItems);
    const keptRows = await activityOf(archivedWithItems, "order.unarchived");
    report(
      "an archived order that already has items keeps them untouched",
      kept.archivedAt === null && kept.items.length === 1 && kept.items[0].figureCount === 3 && itemsCreatedOf(keptRows) === 0,
      `${kept.items.length} item row(s), figure count ${kept.items[0]?.figureCount}, itemsCreated ${itemsCreatedOf(keptRows)}`,
    );

    // A stub payload (no transactions) has nothing to rebuild from.
    await reviseAsVa(archivedStub);
    const stub = await archiveStateOf(archivedStub);
    const stubRows = await activityOf(archivedStub, "order.unarchived");
    report(
      "an archived order with no receipt to rebuild from is revived without items",
      stub.status === "in_design" && stub.archivedAt === null && stub.items.length === 0 && stubRows.length === 1 && itemsCreatedOf(stubRows) === 0,
      `status ${stub.status}, ${stub.items.length} item row(s), ${stubRows.length} order.unarchived row(s)`,
    );

    // A live order is left exactly as a revision always left it.
    await reviseAsVa(liveControl);
    const live = await archiveStateOf(liveControl);
    const liveRows = await activityOf(liveControl, "order.unarchived");
    report(
      "a revision on an order that is not archived writes no revival and no items",
      live.status === "in_design" && live.revisionCount === 1 && live.items.length === 0 && liveRows.length === 0,
      `status ${live.status}, ${live.items.length} item row(s), ${liveRows.length} order.unarchived row(s)`,
    );

    // Only a revision revives: other moves leave an archived order archived.
    await transition(va, { orderId: archivedShipped, to: "delivered", expectedFrom: "shipped" });
    const shipped = await archiveStateOf(archivedShipped);
    const shippedRows = await activityOf(archivedShipped, "order.unarchived");
    report(
      "a forward move on an archived order does not revive it",
      shipped.status === "delivered" && shipped.archivedAt !== null && shipped.items.length === 0 && shippedRows.length === 0,
      `status ${shipped.status}, archivedAt ${shipped.archivedAt ? "still set" : "cleared"}, ${shippedRows.length} order.unarchived row(s)`,
    );

    // The revival shares the revision's transaction: metadata that cannot be
    // stored makes the LAST statement of the transition (the activity row) fail,
    // after the revival already ran, and nothing may stay half done.
    const unstorable: Record<string, unknown> = { ...revisionNote };
    unstorable.self = unstorable;
    let poisoned: unknown = null;
    try {
      await reviseAsVa(archivedPoisoned, unstorable);
    } catch (e) {
      poisoned = e;
    }
    const rolledBack = await archiveStateOf(archivedPoisoned);
    const rolledBackRows = await activityOf(archivedPoisoned, "order.unarchived");
    report(
      "a revision that fails after the revival rolls the revival back",
      poisoned instanceof Error &&
        !(poisoned instanceof OrderTransitionError) &&
        rolledBack.status === "complete" &&
        rolledBack.revisionCount === 0 &&
        rolledBack.archivedAt !== null &&
        rolledBack.items.length === 0 &&
        rolledBackRows.length === 0,
      `${poisoned instanceof Error ? "failed late" : "did not fail"}; status ${rolledBack.status}, archivedAt ${rolledBack.archivedAt ? "still set" : "cleared"}, ${rolledBack.items.length} item row(s), ${rolledBackRows.length} order.unarchived row(s)`,
    );

    // A designer cannot write order_items, so a designer's revival (the QC
    // pullback edge) clears the flag but never builds rows.
    const direct = await withSystemContext((tx) =>
      reviveArchivedOrder(tx, { orderId: archivedDirect, businessId: ctx.businessId, actorId: ctx.d2, reason: "revision", canWriteItems: false }),
    );
    const directState = await archiveStateOf(archivedDirect);
    const directRows = await activityOf(archivedDirect, "order.unarchived");
    report(
      "a revival that may not write items clears the flag and builds no rows",
      direct.revived && direct.itemsCreated === 0 && directState.archivedAt === null && directState.items.length === 0 && directRows.length === 1,
      `revived ${direct.revived}, itemsCreated ${direct.itemsCreated}, ${directState.items.length} item row(s), ${directRows.length} order.unarchived row(s)`,
    );
  } finally {
    // Cascades items and assignments. activity_log is append-only for app_user,
    // so its rows stay (their order_id is nulled), as for the orders above.
    if (seeded.length) await withSystemContext((tx) => tx.delete(orders).where(inArray(orders.id, seeded)));
  }

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
