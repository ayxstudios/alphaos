// Designer load model for one business. Capacity and style come from the same
// designer_profiles fields the assigner uses (lib/orders/assign.ts); this file
// only measures open load against them. Read-only.
import { and, eq, gte, inArray, sql } from "drizzle-orm";

import type { Tx } from "@/lib/db";
import { assignments, designerBusinesses, designerProfiles, orders, users } from "@/lib/db/schema";
import { liveOrderWhere } from "@/lib/orders/archive";
import { quietWindowEnd } from "@/lib/designers/quiet-hours";

/** Working days a designer's daily limit is spread over to get a weekly figure. */
export const WORK_DAYS_PER_WEEK = 5;

/**
 * Statuses that count as open design load. An assigned order waits in
 * ready_to_assign until the designer starts it (ready_to_assign -> in_design),
 * so queued work counts too; assign.ts's "work in flight" is only the started part.
 */
export const LOAD_STATUSES = ["ready_to_assign", "in_design", "awaiting_qc"] as const;

export type DesignerLoad = {
  designerId: string;
  name: string;
  active: boolean;
  styles: string[];
  /** Orders per day (designer_profiles.daily_capacity): the field admins edit. */
  dailyCapacity: number;
  weeklyCapacity: number;
  /** 0 = no cap on work in flight. */
  maxActiveOrders: number;
  /** The limit the load is measured against: the tighter of weekly and max-active. */
  limit: number;
  /** Active assignments on open orders (assign.ts does not weight by figure count). */
  openLoad: number;
  /** Of the open load, assigned but not started yet (the only part the agent may move). */
  queued: number;
  /** Of the open load, orders back with the designer for a revision. */
  inRevision: number;
  assignedToday: number;
  /** open load / limit; above 1 is over capacity. */
  utilisation: number;
  overCapacity: boolean;
  /** Orders above the limit (0 when not over). */
  excess: number;
  away: boolean;
  status: "available" | "full" | "over_capacity" | "quiet_hours" | "deactivated";
  /** Days to clear the open load at the daily limit; null when the daily limit is 0. */
  daysToClear: number | null;
};

export type CapacityModel = {
  businessId: string;
  designers: DesignerLoad[];
};

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export async function loadCapacityModel(
  tx: Tx,
  businessId: string,
  now: Date = new Date(),
): Promise<CapacityModel> {
  const roster = await tx
    .select({
      designerId: designerProfiles.userId,
      name: users.name,
      active: users.active,
      styles: designerProfiles.styles,
      dailyCapacity: designerProfiles.dailyCapacity,
      maxActiveOrders: designerProfiles.maxActiveOrders,
      timezone: designerProfiles.timezone,
      quietStart: designerProfiles.quietStart,
      quietEnd: designerProfiles.quietEnd,
    })
    .from(designerBusinesses)
    .innerJoin(users, and(eq(users.id, designerBusinesses.userId), eq(users.role, "designer")))
    .innerJoin(designerProfiles, eq(designerProfiles.userId, designerBusinesses.userId))
    .where(and(eq(designerBusinesses.businessId, businessId), eq(designerProfiles.isAgent, false)))
    .orderBy(designerProfiles.rank, users.name);
  if (!roster.length) return { businessId, designers: [] };
  const ids = roster.map((r) => r.designerId);

  const load = new Map<string, { open: number; queued: number; revision: number }>();
  for (const r of await tx
    .select({
      designerId: assignments.designerId,
      n: sql<number>`count(*)::int`,
      queued: sql<number>`(count(*) filter (where ${orders.status} = 'ready_to_assign'))::int`,
      rev: sql<number>`(count(*) filter (where ${orders.revisionCount} > 0))::int`,
    })
    .from(assignments)
    .innerJoin(orders, eq(orders.id, assignments.orderId))
    .where(
      and(
        eq(assignments.active, true),
        eq(assignments.businessId, businessId),
        inArray(assignments.designerId, ids),
        inArray(orders.status, [...LOAD_STATUSES]),
        liveOrderWhere(),
      ),
    )
    .groupBy(assignments.designerId)) {
    load.set(r.designerId, { open: Number(r.n), queued: Number(r.queued), revision: Number(r.rev) });
  }

  const today = new Map<string, number>();
  for (const r of await tx
    .select({ designerId: assignments.designerId, n: sql<number>`count(*)::int` })
    .from(assignments)
    .where(and(inArray(assignments.designerId, ids), gte(assignments.assignedAt, sql`date_trunc('day', now())`)))
    .groupBy(assignments.designerId)) {
    today.set(r.designerId, Number(r.n));
  }

  const designers: DesignerLoad[] = roster
    .filter((r) => r.active || (load.get(r.designerId)?.open ?? 0) > 0)
    .map((r) => {
      const weekly = r.dailyCapacity * WORK_DAYS_PER_WEEK;
      const limit = r.maxActiveOrders > 0 ? Math.min(weekly, r.maxActiveOrders) : weekly;
      const l = load.get(r.designerId) ?? { open: 0, queued: 0, revision: 0 };
      const quiet = quietWindowEnd(now, r) != null;
      const over = l.open > limit;
      return {
        designerId: r.designerId,
        name: r.name ?? "Unnamed designer",
        active: r.active,
        styles: r.styles ?? [],
        dailyCapacity: r.dailyCapacity,
        weeklyCapacity: weekly,
        maxActiveOrders: r.maxActiveOrders,
        limit,
        openLoad: l.open,
        queued: l.queued,
        inRevision: l.revision,
        assignedToday: today.get(r.designerId) ?? 0,
        utilisation: limit > 0 ? round1(l.open / limit) : l.open > 0 ? 2 : 0,
        overCapacity: over,
        excess: over ? l.open - limit : 0,
        away: !r.active || quiet,
        status: !r.active ? "deactivated" : over ? "over_capacity" : quiet ? "quiet_hours" : limit > 0 && l.open >= limit ? "full" : "available",
        daysToClear: r.dailyCapacity > 0 ? round1(l.open / r.dailyCapacity) : null,
      };
    });

  return { businessId, designers };
}
