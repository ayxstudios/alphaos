import { and, eq, gte, inArray, ne, sql } from "drizzle-orm";

import type { Tx } from "@/lib/db";
import {
  designerBusinesses,
  designerProfiles,
  users,
  assignments,
  orders,
  orderItems,
  earnings,
} from "@/lib/db/schema";
import { liveOrderWhere } from "@/lib/orders/archive";
import { sendDesignerBrief } from "@/lib/notifications/designer-events";

export const DESIGNER_SLA_HOURS = 24;

/**
 * The one place an assignment row is created. Deactivates any prior active
 * assignment, inserts the new one, and sends the designer their brief
 * (Alpha event `designer.brief`) — this is what makes "every assignment, auto
 * or manual, gets a brief" true without duplicating the send at every call
 * site. `reason` is shown in the brief text (e.g. "Reassigned from another
 * designer." on an SLA-sweep reassignment).
 */
export async function createAssignment(
  tx: Tx,
  input: {
    orderId: string;
    businessId: string;
    designerId: string;
    assignedBy: string | null;
    dueAtHours?: number;
    reason?: string | null;
  },
): Promise<{ assignmentId: string; dueAt: Date }> {
  const dueAt = new Date(Date.now() + (input.dueAtHours ?? DESIGNER_SLA_HOURS) * 60 * 60 * 1000);

  await tx
    .update(assignments)
    .set({ active: false })
    .where(and(eq(assignments.orderId, input.orderId), eq(assignments.active, true)));
  const [row] = await tx
    .insert(assignments)
    .values({
      businessId: input.businessId,
      orderId: input.orderId,
      designerId: input.designerId,
      assignedBy: input.assignedBy,
      dueAt,
      active: true,
    })
    .returning({ id: assignments.id });

  await sendDesignerBrief(tx, {
    orderId: input.orderId,
    designerId: input.designerId,
    dueAt,
    reason: input.reason ?? null,
  });

  return { assignmentId: row.id, dueAt };
}

export type Candidate = {
  designerId: string;
  styles: string[];
  /** Manual priority — LOWER wins. Set by staff on the Designers page. */
  rank: number;
  dailyCapacity: number;
  ordersAssignedToday: number;
  wipCount: number;
  onTimeRate30d: number; // 0..1
  /** 0 = no cap on work in flight (designer_profiles.max_active_orders). */
  maxActiveOrders: number;
};

export type RankedCandidate = Candidate & {
  styleMatch: boolean;
  remainingCapacity: number;
};

/**
 * PURE ranker (no DB) — testable in isolation.
 *
 * Hard filters (all must pass to be eligible):
 *  1. Under the daily capacity (a limit of 15 = at most 15 assigned today).
 *  2. Under their max active orders (0 = no cap) — work currently in flight
 *     (in_design / awaiting_qc), so a designer with a lot on their plate isn't
 *     handed more even if today's count is still low.
 *  3. STRICT style match — when the order has a style, only designers who list
 *     that style are eligible. An order with no style is open to everyone.
 *     (If no eligible designer exists the order stays unassigned — the caller
 *     surfaces it in the VA "Unassigned" tab.)
 *
 * Order among the eligible: manual rank (asc) -> most remaining capacity ->
 * lowest work-in-progress -> best 30-day on-time rate.
 */
export function rankCandidates(
  candidates: Candidate[],
  order: { style?: string | null },
): RankedCandidate[] {
  const style = order.style?.trim().toLowerCase() || null;

  const eligible = candidates
    .map((c) => ({
      ...c,
      styleMatch: !!style && c.styles.some((s) => s.trim().toLowerCase() === style),
      remainingCapacity: c.dailyCapacity - c.ordersAssignedToday,
    }))
    .filter(
      (c) =>
        c.ordersAssignedToday < c.dailyCapacity &&
        (c.maxActiveOrders === 0 || c.wipCount < c.maxActiveOrders) &&
        // Strict: a styled order goes only to a matching designer.
        (style === null || c.styleMatch),
    );

  eligible.sort(
    (a, b) =>
      a.rank - b.rank ||
      b.remainingCapacity - a.remainingCapacity ||
      a.wipCount - b.wipCount ||
      b.onTimeRate30d - a.onTimeRate30d,
  );

  return eligible;
}

/**
 * Ranked, eligible candidates for a business + style, straight from the DB.
 * Shared by auto-assign (entry into ready_to_assign) and the SLA-sweep
 * reassign step (48 h, no submission) — `excludeDesignerId` drops the
 * currently-assigned designer so a reassignment never picks the same person.
 */
async function loadRankedCandidates(
  tx: Tx,
  input: { businessId: string; style: string | null; excludeDesignerId?: string | null },
): Promise<RankedCandidate[]> {
  const roster = await tx
    .select({
      designerId: designerProfiles.userId,
      dailyCapacity: designerProfiles.dailyCapacity,
      styles: designerProfiles.styles,
      rank: designerProfiles.rank,
      maxActiveOrders: designerProfiles.maxActiveOrders,
    })
    .from(designerBusinesses)
    .innerJoin(
      users,
      and(eq(users.id, designerBusinesses.userId), eq(users.active, true), eq(users.role, "designer")),
    )
    .innerJoin(designerProfiles, eq(designerProfiles.userId, designerBusinesses.userId))
    .where(
      and(
        eq(designerBusinesses.businessId, input.businessId),
        ...(input.excludeDesignerId ? [ne(designerProfiles.userId, input.excludeDesignerId)] : []),
      ),
    );

  if (!roster.length) return [];
  const ids = roster.map((r) => r.designerId);

  // assigned today
  const assignedToday = new Map<string, number>();
  for (const r of await tx
    .select({ designerId: assignments.designerId, n: sql<number>`count(*)::int` })
    .from(assignments)
    .where(and(inArray(assignments.designerId, ids), gte(assignments.assignedAt, sql`date_trunc('day', now())`)))
    .groupBy(assignments.designerId)) {
    assignedToday.set(r.designerId, Number(r.n));
  }

  // work in progress (active assignments on actively-worked orders)
  const wip = new Map<string, number>();
  for (const r of await tx
    .select({ designerId: assignments.designerId, n: sql<number>`count(*)::int` })
    .from(assignments)
    .innerJoin(orders, eq(orders.id, assignments.orderId))
    .where(
      and(
        eq(assignments.active, true),
        inArray(assignments.designerId, ids),
        inArray(orders.status, ["in_design", "awaiting_qc"]),
        liveOrderWhere(),
      ),
    )
    .groupBy(assignments.designerId)) {
    wip.set(r.designerId, Number(r.n));
  }

  // 30-day on-time rate (earnings.created_at ~= completion time)
  const onTime = new Map<string, number>();
  for (const r of await tx
    .select({
      designerId: earnings.designerId,
      total: sql<number>`count(*)::int`,
      ontime: sql<number>`count(*) filter (where ${earnings.createdAt} <= ${orders.dueAt})::int`,
    })
    .from(earnings)
    .innerJoin(orders, eq(orders.id, earnings.orderId))
    .where(and(inArray(earnings.designerId, ids), gte(earnings.createdAt, sql`now() - interval '30 days'`)))
    .groupBy(earnings.designerId)) {
    onTime.set(r.designerId, Number(r.total) ? Number(r.ontime) / Number(r.total) : 1);
  }

  const candidates: Candidate[] = roster.map((r) => ({
    designerId: r.designerId,
    styles: r.styles ?? [],
    rank: r.rank,
    dailyCapacity: r.dailyCapacity,
    ordersAssignedToday: assignedToday.get(r.designerId) ?? 0,
    wipCount: wip.get(r.designerId) ?? 0,
    onTimeRate30d: onTime.get(r.designerId) ?? 1,
    maxActiveOrders: r.maxActiveOrders,
  }));

  return rankCandidates(candidates, { style: input.style });
}

/**
 * Runs when an order enters ready_to_assign. Builds candidates from the DB,
 * ranks them, and assigns the top one (deactivating any prior active
 * assignment). If nobody is eligible the order stays ready_to_assign with no
 * active assignment — it surfaces in the VA "Unassigned" tab.
 */
export async function runAutoAssign(
  tx: Tx,
  order: { orderId: string; businessId: string; assignedBy: string | null },
): Promise<{ assigned: string | null }> {
  const [item] = await tx
    .select({ style: orderItems.style })
    .from(orderItems)
    .where(eq(orderItems.orderId, order.orderId))
    .limit(1);
  const style = item?.style ?? null;

  const ranked = await loadRankedCandidates(tx, { businessId: order.businessId, style });
  if (!ranked.length) return { assigned: null };
  const chosen = ranked[0].designerId;

  await createAssignment(tx, {
    orderId: order.orderId,
    businessId: order.businessId,
    designerId: chosen,
    assignedBy: order.assignedBy,
  });

  return { assigned: chosen };
}

/**
 * The next eligible designer for an order, excluding whoever currently holds
 * it — used by the 48 h SLA-sweep reassignment. Same ranking as auto-assign.
 * Returns null when nobody else is eligible (the sweep then leaves the order
 * with its current designer and only pings the VA).
 */
export async function findNextEligibleDesigner(
  tx: Tx,
  input: { businessId: string; style: string | null; excludeDesignerId: string },
): Promise<string | null> {
  const ranked = await loadRankedCandidates(tx, input);
  return ranked[0]?.designerId ?? null;
}
