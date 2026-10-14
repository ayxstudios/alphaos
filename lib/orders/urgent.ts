// Urgent orders (Yousif 2026-10-12): when a buyer chases an order that is
// stalled, or an old/legacy one that never made it in, a VA/admin or the agent
// marks it URGENT. Urgent cards sort first on every board, queue and list, and
// the agent works them even when they predate its go-live cutoff
// (lib/agent/scope.ts). Marking never moves an existing customer deadline; an
// order with no deadline yet gets one 24 h out. An archived (pre-cutoff) order
// is brought back to the live boards, since a buyer chasing it means it is live.
// updated_at is left alone on purpose: it drives "waiting since" on the QC list.
import { and, desc, eq } from "drizzle-orm";

import type { Tx } from "@/lib/db";
import { activityLog, assignments, orders, qcChecks } from "@/lib/db/schema";
import { sendQcFixUrgent } from "@/lib/notifications/designer-events";
import { businessSlaHours } from "@/lib/orders/assign";

/** Who may mark or clear urgent from the app. Designers and helpers only see it. */
export function canManageUrgent(role: string | null | undefined): boolean {
  return role === "admin" || role === "va";
}

export const URGENT_REASON_MAX = 300;
export const URGENT_DEFAULT_DUE_HOURS = 24;

export function cleanUrgentReason(reason: string | null | undefined): string | null {
  const text = (reason ?? "").replace(/\s+/g, " ").trim().slice(0, URGENT_REASON_MAX);
  return text || null;
}

/**
 * The deadline an order gets when it is marked urgent: its own deadline if it
 * already has one (orders.due_at never moves, CLAUDE.md Deadlines), else 24 h
 * from now.
 */
export function urgentDueAt(current: Date | null, now: Date = new Date()): Date {
  return current ?? new Date(now.getTime() + URGENT_DEFAULT_DUE_HOURS * 3600 * 1000);
}

/** Urgent first, then the list's own order. Stable for equal keys. */
export function urgentFirst<T>(rows: T[], isUrgent: (row: T) => boolean): T[] {
  return rows
    .map((row, i) => ({ row, i, u: isUrgent(row) ? 0 : 1 }))
    .sort((a, b) => a.u - b.u || a.i - b.i)
    .map((x) => x.row);
}

export type UrgentChange =
  | { ok: true; urgentAt: Date | null; dueAt: Date | null; changed: boolean }
  | { ok: false; message: string };

/**
 * Yousif 2026-10-14: an urgent revision is due in a few hours. If the order is
 * already back with its designer after a QC fail (in_design, newest QC check a
 * fail), shorten the active assignment's due_at to at most now +
 * urgentRevisionSlaHours and message the designer at once. Never lengthens a
 * deadline.
 */
async function tightenQcFailDeadline(
  tx: Tx,
  order: { id: string; status: string; businessId: string },
  now: Date,
): Promise<void> {
  if (order.status !== "in_design") return;
  const [last] = await tx
    .select({ result: qcChecks.result })
    .from(qcChecks)
    .where(eq(qcChecks.orderId, order.id))
    .orderBy(desc(qcChecks.createdAt))
    .limit(1);
  if (last?.result !== "fail") return;
  const [a] = await tx
    .select({ id: assignments.id, dueAt: assignments.dueAt, designerId: assignments.designerId })
    .from(assignments)
    .where(and(eq(assignments.orderId, order.id), eq(assignments.active, true)))
    .limit(1);
  if (!a) return;
  const { urgentRevision } = await businessSlaHours(tx, order.businessId);
  const cap = new Date(now.getTime() + urgentRevision * 3600 * 1000);
  if (a.dueAt && a.dueAt <= cap) return;
  await tx.update(assignments).set({ dueAt: cap }).where(eq(assignments.id, a.id));
  // Only when the clock actually got shorter, so re-marking never repeats it.
  await sendQcFixUrgent(tx, { orderId: order.id, designerId: a.designerId, dueAt: cap, now });
}

/**
 * Mark (urgent=true) or clear an order's urgent flag inside the caller's
 * transaction (withUserContext for a person, withSystemContext for the agent),
 * writing one activity_log row. `actorId` null = the agent/system.
 */
export async function setOrderUrgent(
  tx: Tx,
  input: { orderId: string; urgent: boolean; reason?: string | null; actorId: string | null; via: "app" | "agent" | "new_order" },
): Promise<UrgentChange> {
  const [order] = await tx
    .select({
      id: orders.id,
      status: orders.status,
      businessId: orders.businessId,
      dueAt: orders.dueAt,
      urgentAt: orders.urgentAt,
      archivedAt: orders.archivedAt,
    })
    .from(orders)
    .where(eq(orders.id, input.orderId))
    .limit(1);
  if (!order) return { ok: false, message: "Order not found." };

  const reason = cleanUrgentReason(input.reason);
  if (input.urgent) {
    const now = new Date();
    const dueAt = urgentDueAt(order.dueAt, now);
    const urgentAt = order.urgentAt ?? now;
    await tx
      .update(orders)
      .set({
        urgentAt,
        urgentReason: reason,
        urgentBy: input.actorId ?? "agent",
        dueAt,
        ...(order.archivedAt ? { archivedAt: null, archiveReason: null } : {}),
      })
      .where(eq(orders.id, order.id));
    await tightenQcFailDeadline(tx, order, now);
    await tx.insert(activityLog).values({
      businessId: order.businessId,
      orderId: order.id,
      actorId: input.actorId,
      action: "order.marked_urgent",
      metadata: {
        reason,
        via: input.via,
        dueSet: !order.dueAt ? dueAt.toISOString() : null,
        unarchived: !!order.archivedAt,
      },
    });
    return { ok: true, urgentAt, dueAt, changed: !order.urgentAt };
  }

  if (!order.urgentAt) return { ok: true, urgentAt: null, dueAt: order.dueAt, changed: false };
  await tx
    .update(orders)
    .set({ urgentAt: null, urgentReason: null, urgentBy: null })
    .where(eq(orders.id, order.id));
  await tx.insert(activityLog).values({
    businessId: order.businessId,
    orderId: order.id,
    actorId: input.actorId,
    action: "order.cleared_urgent",
    metadata: { reason, via: input.via },
  });
  return { ok: true, urgentAt: null, dueAt: order.dueAt, changed: true };
}
