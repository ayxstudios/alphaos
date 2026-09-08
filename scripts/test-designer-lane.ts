/**
 * Designer lane invariants (Alpha brief on assignment, 24h nudge, 48h
 * reassign, QC feedback): creates temporary orders/assignments against the
 * seed DB's existing shop/business/designers, drives the sweep with a fixed
 * `now`, and deletes its rows at the end.
 */
import "./load-env";
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";

import { withSystemContext, type RequestUser } from "../lib/db";
import {
  alphaEvents,
  activityLog,
  assets,
  assignments,
  designerBusinesses,
  orders,
  shops,
  users,
} from "../lib/db/schema";
import { runDesignerLaneSweep } from "../lib/notifications/designer-sweep";
import { transition, OrderTransitionError } from "../lib/orders/transitions";
import { DEFAULT_CHECKLIST } from "../lib/qc/checklist";

let failures = 0;
const cleanup = { orderIds: [] as string[] };

function report(name: string, pass: boolean, detail: string) {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
  console.log(`      ${detail}`);
  if (!pass) failures += 1;
}

const HOUR = 60 * 60 * 1000;

async function createOrder(input: { businessId: string; shopId: string; designerId: string; assignedAt: Date }) {
  return withSystemContext(async (tx) => {
    const id = randomUUID();
    await tx.insert(orders).values({
      id,
      businessId: input.businessId,
      shopId: input.shopId,
      platformOrderId: `LANE-${Date.now()}-${cleanup.orderIds.length}`,
      platformOrderName: `LANE-${cleanup.orderIds.length}`,
      status: "in_design",
      source: "manual",
      uploadToken: randomUUID(),
    });
    cleanup.orderIds.push(id);
    await tx.insert(assignments).values({
      businessId: input.businessId,
      orderId: id,
      designerId: input.designerId,
      assignedAt: input.assignedAt,
      dueAt: new Date(input.assignedAt.getTime() + 24 * HOUR),
      active: true,
    });
    return id;
  });
}

async function addSubmission(orderId: string, businessId: string, createdAt: Date) {
  await withSystemContext((tx) =>
    tx.insert(assets).values({
      businessId,
      orderId,
      type: "submission",
      storage: "cdn",
      url: `https://example.com/${orderId}.jpg`,
      createdAt,
    }),
  );
}

async function alphaEventsFor(orderId: string, type: string) {
  return withSystemContext((tx) =>
    tx
      .select({ id: alphaEvents.id, toUserId: alphaEvents.toUserId, text: alphaEvents.text })
      .from(alphaEvents)
      .where(and(eq(alphaEvents.orderId, orderId), eq(alphaEvents.type, type)))
      .orderBy(desc(alphaEvents.createdAt)),
  );
}

async function activeAssignment(orderId: string) {
  const [row] = await withSystemContext((tx) =>
    tx
      .select({ designerId: assignments.designerId })
      .from(assignments)
      .where(and(eq(assignments.orderId, orderId), eq(assignments.active, true)))
      .limit(1),
  );
  return row?.designerId ?? null;
}

async function cleanupRows() {
  await withSystemContext(async (tx) => {
    if (!cleanup.orderIds.length) return;
    // orders cascades assignments and assets. activity_log/alpha_events are the
    // immutable audit trail (app_user has no DELETE grant on them, by design —
    // their order_id FK is ON DELETE SET NULL) — same convention as the other
    // test scripts (see scripts/test-transitions.ts): only orders is deleted.
    await tx.delete(orders).where(inArray(orders.id, cleanup.orderIds));
  });
}

async function main() {
  const ctx = await withSystemContext(async (tx) => {
    const [shop] = await tx.select({ id: shops.id, businessId: shops.businessId }).from(shops).limit(1);
    if (!shop) throw new Error("Need at least one shop in the database");
    const [va] = await tx.select({ id: users.id }).from(users).where(eq(users.role, "va")).limit(1);
    if (!va) throw new Error("Need at least one VA in the database");
    const designers = await tx
      .select({ id: users.id })
      .from(users)
      .innerJoin(designerBusinesses, and(eq(designerBusinesses.userId, users.id), eq(designerBusinesses.businessId, shop.businessId)))
      .where(eq(users.role, "designer"));
    if (designers.length < 2) throw new Error("Need at least two designers linked to the seed business");
    return { shopId: shop.id, businessId: shop.businessId, vaId: va.id, d1: designers[0].id, d2: designers[1].id };
  });

  const now = new Date();

  try {
    // --- 1. Nudge fires once at 24h with no submission -------------------
    const nudgeOrder = await createOrder({
      businessId: ctx.businessId,
      shopId: ctx.shopId,
      designerId: ctx.d1,
      assignedAt: new Date(now.getTime() - 25 * HOUR),
    });

    const first = await withSystemContext((tx) => runDesignerLaneSweep(tx, now, { enabled: true }));
    const nudgeEventsAfterFirst = await alphaEventsFor(nudgeOrder, "designer.nudge");
    report(
      "nudge fires at 24h with no submission",
      first.nudgeFired >= 1 && nudgeEventsAfterFirst.length === 1,
      `nudgeFired=${first.nudgeFired}, designer.nudge events=${nudgeEventsAfterFirst.length}`,
    );

    const second = await withSystemContext((tx) => runDesignerLaneSweep(tx, now, { enabled: true }));
    const nudgeEventsAfterSecond = await alphaEventsFor(nudgeOrder, "designer.nudge");
    report(
      "nudge is idempotent (fires exactly once)",
      nudgeEventsAfterSecond.length === 1 && second.skippedDuplicate >= 1,
      `designer.nudge events=${nudgeEventsAfterSecond.length}, second-run skippedDuplicate=${second.skippedDuplicate}`,
    );

    // --- 2. Reassign at 48h with no submission ----------------------------
    const reassignOrder = await createOrder({
      businessId: ctx.businessId,
      shopId: ctx.shopId,
      designerId: ctx.d1,
      assignedAt: new Date(now.getTime() - 49 * HOUR),
    });

    const reassignRun = await withSystemContext((tx) => runDesignerLaneSweep(tx, now, { enabled: true }));
    const newDesigner = await activeAssignment(reassignOrder);
    const reassignedEvents = await alphaEventsFor(reassignOrder, "designer.reassigned");
    const briefEvents = await alphaEventsFor(reassignOrder, "designer.brief");
    const vaEvents = await alphaEventsFor(reassignOrder, "va.attention");
    const [logRow] = await withSystemContext((tx) =>
      tx
        .select({ action: activityLog.action, metadata: activityLog.metadata })
        .from(activityLog)
        .where(and(eq(activityLog.orderId, reassignOrder), eq(activityLog.action, "order.reassigned")))
        .orderBy(desc(activityLog.createdAt))
        .limit(1),
    );
    report(
      "reassigns to the next eligible designer at 48h",
      reassignRun.reassigned >= 1 && newDesigner !== null && newDesigner !== ctx.d1,
      `reassigned=${reassignRun.reassigned}, newDesigner=${newDesigner}`,
    );
    report(
      "reassignment leaves an activity_log row with a reason",
      !!logRow && typeof (logRow.metadata as Record<string, unknown> | null)?.reason === "string",
      `activityLog row=${JSON.stringify(logRow)}`,
    );
    report(
      "designer.reassigned sent to both designers",
      reassignedEvents.length >= 2 &&
        reassignedEvents.some((e) => e.toUserId === ctx.d1) &&
        reassignedEvents.some((e) => e.toUserId === newDesigner),
      `designer.reassigned events=${reassignedEvents.length}`,
    );
    report("designer.brief sent to the new designer", briefEvents.length >= 1, `designer.brief events=${briefEvents.length}`);
    report("va.attention sent on reassignment", vaEvents.length >= 1, `va.attention events=${vaEvents.length}`);

    // --- 3. Never reassign an order with a submission awaiting QC --------
    const protectedOrder = await createOrder({
      businessId: ctx.businessId,
      shopId: ctx.shopId,
      designerId: ctx.d1,
      assignedAt: new Date(now.getTime() - 50 * HOUR),
    });
    await addSubmission(protectedOrder, ctx.businessId, new Date(now.getTime() - 10 * HOUR));

    const protectedRun = await withSystemContext((tx) => runDesignerLaneSweep(tx, now, { enabled: true }));
    const stillD1 = await activeAssignment(protectedOrder);
    const protectedNudge = await alphaEventsFor(protectedOrder, "designer.nudge");
    const protectedReassign = await alphaEventsFor(protectedOrder, "designer.reassigned");
    report(
      "an order with a submission is never nudged or reassigned",
      stillD1 === ctx.d1 && protectedNudge.length === 0 && protectedReassign.length === 0,
      `still with d1=${stillD1 === ctx.d1}, nudge events=${protectedNudge.length}, reassigned events=${protectedReassign.length}, thisRun.reassigned=${protectedRun.reassigned}`,
    );

    // --- 4. QC fail sends designer.qc_feedback ----------------------------
    // (createAssignment — used by both auto-assign and the sweep reassign
    // above — already proved designer.brief fires on assignment via the
    // reassignment case: briefEvents.length >= 1.)
    const qcOrder = await createOrder({
      businessId: ctx.businessId,
      shopId: ctx.shopId,
      designerId: ctx.d1,
      assignedAt: now,
    });
    await addSubmission(qcOrder, ctx.businessId, now);
    const vaUser: RequestUser = { id: ctx.vaId, role: "va" };
    try {
      await transition(vaUser, { orderId: qcOrder, to: "awaiting_qc", expectedFrom: "in_design" });
      const passingResults = Object.fromEntries(DEFAULT_CHECKLIST.map((item, i) => [item.key, i !== 0]));
      await transition(vaUser, {
        orderId: qcOrder,
        to: "in_design",
        expectedFrom: "awaiting_qc",
        metadata: { reason: "Ring does not match the reference photo.", itemResults: passingResults },
      });
    } catch (err) {
      if (!(err instanceof OrderTransitionError)) throw err;
    }
    const qcEvents = await alphaEventsFor(qcOrder, "designer.qc_feedback");
    report(
      "QC fail sends designer.qc_feedback with the failed items",
      qcEvents.length >= 1 && qcEvents[0].text.includes("did not pass QC"),
      `designer.qc_feedback events=${qcEvents.length}`,
    );
  } finally {
    await cleanupRows();
  }

  console.log(failures === 0 ? `\nAll checks passed.` : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
