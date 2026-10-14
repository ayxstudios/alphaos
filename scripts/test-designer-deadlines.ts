/**
 * Designer deadlines (Yousif 2026-10-14: "revisions need to be done in 24 hours,
 * orders also within 24 hours, Pixart orders can be 48 hours"). Proves:
 *  - a new assignment gets the business's designerSlaHours (default 24, 48 when set),
 *  - a QC fail and a customer revision give the active assignment a fresh
 *    revisionSlaHours deadline (default 24) instead of the old, past one.
 * Creates throwaway TEST orders and restores the business config. Run on the
 * demo/staging db only.
 */
import "./load-env";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";

import { withSystemContext, type RequestUser } from "../lib/db";
import { orders, orderItems, assignments, users, shops, designerBusinesses, assets, businesses } from "../lib/db/schema";
import { DEFAULT_CHECKLIST } from "../lib/qc/checklist";
import { createAssignment } from "../lib/orders/assign";
import { transition, type OrderStatus } from "../lib/orders/transitions";
import { setOrderUrgent } from "../lib/orders/urgent";
import { qcFeedbackDeadline } from "../lib/notifications/designer-events";

const H = 3600e3;
let failures = 0;
function report(name: string, pass: boolean, detail: string) {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}\n      ${detail}`);
  if (!pass) failures += 1;
}
const near = (d: Date | null | undefined, hours: number) => !!d && Math.abs(d.getTime() - (Date.now() + hours * H)) < 5 * 60e3;

async function activeDue(orderId: string): Promise<Date | null> {
  return withSystemContext(async (tx) => {
    const [a] = await tx.select({ dueAt: assignments.dueAt }).from(assignments)
      .where(and(eq(assignments.orderId, orderId), eq(assignments.active, true)));
    return a?.dueAt ?? null;
  });
}

async function main() {
  const ctx = await withSystemContext(async (tx) => {
    const [row] = await tx
      .select({ designerId: designerBusinesses.userId, businessId: shops.businessId, shopId: shops.id })
      .from(shops)
      .innerJoin(designerBusinesses, eq(designerBusinesses.businessId, shops.businessId))
      .innerJoin(users, eq(users.id, designerBusinesses.userId))
      .where(eq(users.role, "designer"))
      .limit(1);
    const [staff] = await tx.select({ id: users.id, role: users.role }).from(users).where(eq(users.role, "admin")).limit(1);
    const [biz] = await tx.select({ agentConfig: businesses.agentConfig }).from(businesses).where(eq(businesses.id, row.businessId));
    return { ...row, staff, agentConfig: biz.agentConfig };
  });
  const staff: RequestUser = { id: ctx.staff.id, role: ctx.staff.role as RequestUser["role"] };

  async function makeOrder(status: OrderStatus, due: Date) {
    const id = randomUUID();
    await withSystemContext(async (tx) => {
      await tx.insert(orders).values({ id, businessId: ctx.businessId, shopId: ctx.shopId, platformOrderId: `DEADLINE-${Date.now()}-${status}`,
        status, source: "manual", uploadToken: randomUUID() });
      await tx.insert(orderItems).values({ businessId: ctx.businessId, orderId: id, figureCount: 1, figureCountSource: "manual", productType: "digital" });
      await tx.insert(assignments).values({ businessId: ctx.businessId, orderId: id, designerId: ctx.designerId, active: true, dueAt: due });
      await tx.insert(assets).values({ businessId: ctx.businessId, orderId: id, type: "submission", storage: "cdn", url: `https://example.com/${id}.jpg` });
    });
    return id;
  }
  const created: string[] = [];
  try {
    // 1. default 24 h on a new assignment
    await withSystemContext((tx) => tx.update(businesses).set({ agentConfig: { ...(ctx.agentConfig ?? {}), designerSlaHours: undefined, revisionSlaHours: undefined } }).where(eq(businesses.id, ctx.businessId)));
    const o1 = await makeOrder("in_design", new Date(Date.now() - 50 * H)); created.push(o1);
    const r1 = await withSystemContext((tx) => createAssignment(tx, { orderId: o1, businessId: ctx.businessId, designerId: ctx.designerId, assignedBy: null }));
    report("new assignment, default config = 24 h", near(r1.dueAt, 24), `due ${r1.dueAt.toISOString()}`);

    // 2. designerSlaHours 48 (PixArt)
    await withSystemContext((tx) => tx.update(businesses).set({ agentConfig: { ...(ctx.agentConfig ?? {}), designerSlaHours: 48 } }).where(eq(businesses.id, ctx.businessId)));
    const r2 = await withSystemContext((tx) => createAssignment(tx, { orderId: o1, businessId: ctx.businessId, designerId: ctx.designerId, assignedBy: null }));
    report("new assignment, designerSlaHours 48 = 48 h", near(r2.dueAt, 48), `due ${r2.dueAt.toISOString()}`);
    report("explicit dueAtHours still wins", near((await withSystemContext((tx) => createAssignment(tx, { orderId: o1, businessId: ctx.businessId, designerId: ctx.designerId, assignedBy: null, dueAtHours: 6 }))).dueAt, 6), "6 h");

    // 3. QC fail resets a past deadline to 24 h (revisionSlaHours default even when designerSlaHours is 48)
    const o2 = await makeOrder("awaiting_qc", new Date(Date.now() - 30 * H)); created.push(o2);
    const fails = Object.fromEntries(DEFAULT_CHECKLIST.map((it, i) => [it.key, i !== 0]));
    await transition(staff, { orderId: o2, to: "in_design", expectedFrom: "awaiting_qc",
      metadata: { signature: "Deadline Test", reason: "Deadline test: fix the tattoo", itemResults: fails, failedItems: [DEFAULT_CHECKLIST[0].label] } });
    const d2 = await activeDue(o2);
    report("QC fail = fresh 12 h revision deadline (qcFailSlaHours default)", near(d2, 12), `due ${d2?.toISOString()}`);

    // 4. customer revision (awaiting_approval -> in_design) resets too
    const o3 = await makeOrder("awaiting_approval", new Date(Date.now() - 72 * H)); created.push(o3);
    await transition(staff, { orderId: o3, to: "in_design", expectedFrom: "awaiting_approval", metadata: { via: "va_created_revision", revisionReason: "test" } });
    const d3 = await activeDue(o3);
    report("customer revision = fresh 24 h deadline", near(d3, 24), `due ${d3?.toISOString()}`);

    // 5. QC fail on an URGENT order = 3 h
    const o4 = await makeOrder("awaiting_qc", new Date(Date.now() - 30 * H)); created.push(o4);
    await withSystemContext((tx) => tx.update(orders).set({ urgentAt: new Date() }).where(eq(orders.id, o4)));
    await transition(staff, { orderId: o4, to: "in_design", expectedFrom: "awaiting_qc",
      metadata: { signature: "Deadline Test", reason: "Deadline test: urgent fix", itemResults: fails, failedItems: [DEFAULT_CHECKLIST[0].label] } });
    const d4 = await activeDue(o4);
    report("urgent QC fail = 3 h", near(d4, 3), `due ${d4?.toISOString()}`);

    // 6. customer revision on an URGENT order = 3 h
    const o5 = await makeOrder("awaiting_approval", new Date(Date.now() - 72 * H)); created.push(o5);
    await withSystemContext((tx) => tx.update(orders).set({ urgentAt: new Date() }).where(eq(orders.id, o5)));
    await transition(staff, { orderId: o5, to: "in_design", expectedFrom: "awaiting_approval", metadata: { via: "va_created_revision", revisionReason: "test" } });
    const d5 = await activeDue(o5);
    report("urgent customer revision = 3 h", near(d5, 3), `due ${d5?.toISOString()}`);

    // 7. flag urgent AFTER the QC fail: active assignment tightens to 3 h
    const o6 = await makeOrder("awaiting_qc", new Date(Date.now() - 30 * H)); created.push(o6);
    await transition(staff, { orderId: o6, to: "in_design", expectedFrom: "awaiting_qc",
      metadata: { signature: "Deadline Test", reason: "Deadline test: fix", itemResults: fails, failedItems: [DEFAULT_CHECKLIST[0].label] } });
    report("before urgent flag = 12 h", near(await activeDue(o6), 12), "");
    await withSystemContext((tx) => setOrderUrgent(tx, { orderId: o6, urgent: true, actorId: null, via: "agent" }));
    const d6 = await activeDue(o6);
    report("marking urgent after a QC fail tightens to 3 h", near(d6, 3), `due ${d6?.toISOString()}`);

    // 8. wording comes from the real due_at, in the designer's timezone
    const now = new Date("2026-10-14T03:00:00Z");
    const norm = qcFeedbackDeadline(new Date("2026-10-14T15:00:00Z"), now, "Asia/Jakarta", false);
    report("normal wording", norm?.normalLine === "Please upload the fix by Wed 22:00 your time (12 h).", String(norm?.normalLine));
    const urg = qcFeedbackDeadline(new Date("2026-10-14T06:00:00Z"), now, "Asia/Jakarta", true);
    report("urgent wording", urg?.urgentLine === "URGENT: the customer is waiting. Please upload the fix within 3 hours, by 13:00 your time.", String(urg?.urgentLine));
  } finally {
    await withSystemContext(async (tx) => {
      await tx.update(businesses).set({ agentConfig: ctx.agentConfig }).where(eq(businesses.id, ctx.businessId));
      for (const id of created) await tx.update(orders).set({ archivedAt: new Date() }).where(eq(orders.id, id));
    });
  }
  console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
