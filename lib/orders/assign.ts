import { and, eq, gte, inArray, sql } from "drizzle-orm";

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

const DESIGNER_SLA_HOURS = 24;

export type Candidate = {
  designerId: string;
  styles: string[];
  dailyCapacity: number;
  ordersAssignedToday: number;
  wipCount: number;
  onTimeRate30d: number; // 0..1
};

export type RankedCandidate = Candidate & {
  styleMatch: boolean;
  remainingCapacity: number;
};

/**
 * PURE ranker (no DB) — testable in isolation.
 *
 * Hard filter: only designers under their daily capacity are eligible.
 * Rank: style match (soft boost, never excludes) -> most remaining capacity ->
 * lowest work-in-progress -> best 30-day on-time rate.
 */
export function rankCandidates(
  candidates: Candidate[],
  order: { style?: string | null },
): RankedCandidate[] {
  const style = order.style?.trim().toLowerCase() || null;

  const eligible = candidates
    .filter((c) => c.ordersAssignedToday < c.dailyCapacity)
    .map((c) => ({
      ...c,
      styleMatch: !!style && c.styles.some((s) => s.trim().toLowerCase() === style),
      remainingCapacity: c.dailyCapacity - c.ordersAssignedToday,
    }));

  eligible.sort(
    (a, b) =>
      Number(b.styleMatch) - Number(a.styleMatch) ||
      b.remainingCapacity - a.remainingCapacity ||
      a.wipCount - b.wipCount ||
      b.onTimeRate30d - a.onTimeRate30d,
  );

  return eligible;
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

  const roster = await tx
    .select({
      designerId: designerProfiles.userId,
      dailyCapacity: designerProfiles.dailyCapacity,
      styles: designerProfiles.styles,
    })
    .from(designerBusinesses)
    .innerJoin(
      users,
      and(eq(users.id, designerBusinesses.userId), eq(users.active, true), eq(users.role, "designer")),
    )
    .innerJoin(designerProfiles, eq(designerProfiles.userId, designerBusinesses.userId))
    .where(eq(designerBusinesses.businessId, order.businessId));

  if (!roster.length) return { assigned: null };
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
    dailyCapacity: r.dailyCapacity,
    ordersAssignedToday: assignedToday.get(r.designerId) ?? 0,
    wipCount: wip.get(r.designerId) ?? 0,
    onTimeRate30d: onTime.get(r.designerId) ?? 1,
  }));

  const ranked = rankCandidates(candidates, { style });
  if (!ranked.length) return { assigned: null };
  const chosen = ranked[0].designerId;

  // Exactly one active assignment per order.
  await tx
    .update(assignments)
    .set({ active: false })
    .where(and(eq(assignments.orderId, order.orderId), eq(assignments.active, true)));
  await tx.insert(assignments).values({
    businessId: order.businessId,
    orderId: order.orderId,
    designerId: chosen,
    assignedBy: order.assignedBy,
    dueAt: new Date(Date.now() + DESIGNER_SLA_HOURS * 60 * 60 * 1000),
    active: true,
  });

  return { assigned: chosen };
}
