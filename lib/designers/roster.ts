import { cache } from "react";
import { and, asc, eq, gte, inArray, sql } from "drizzle-orm";

import { withUserContext, type RequestUser } from "@/lib/db";
import { assignments, designerProfiles, orders, users } from "@/lib/db/schema";

export type RailDesigner = {
  id: string;
  name: string;
  assignedToday: number;
  dailyCapacity: number;
};

/**
 * Lean designer list for the app-shell rail (shown on every page for staff):
 * id, name, today's load — no WIP. Ordered by manual rank. Wrapped in React
 * cache() keyed on primitives so the layout and any page in the same request
 * share one result (two queries), keeping every navigation cheap.
 */
export function getRailDesigners(user: RequestUser): Promise<RailDesigner[]> {
  return railDesignersCached(user.id, user.role);
}

const railDesignersCached = cache(
  async (userId: string, role: RequestUser["role"]): Promise<RailDesigner[]> => {
    const user: RequestUser = { id: userId, role };
    return withUserContext(user, async (tx) => {
      const roster = await tx
        .select({
          userId: designerProfiles.userId,
          name: users.name,
          dailyCapacity: designerProfiles.dailyCapacity,
        })
        .from(designerProfiles)
        .innerJoin(
          users,
          and(eq(users.id, designerProfiles.userId), eq(users.active, true), eq(users.role, "designer")),
        )
        .orderBy(asc(designerProfiles.rank), asc(users.name));

      if (!roster.length) return [];
      const ids = roster.map((r) => r.userId);

      const assignedToday = new Map<string, number>();
      for (const r of await tx
        .select({ designerId: assignments.designerId, n: sql<number>`count(*)::int` })
        .from(assignments)
        .where(
          and(
            inArray(assignments.designerId, ids),
            gte(assignments.assignedAt, sql`date_trunc('day', now())`),
          ),
        )
        .groupBy(assignments.designerId)) {
        assignedToday.set(r.designerId, Number(r.n));
      }

      return roster.map((r) => ({
        id: r.userId,
        name: r.name ?? "Unnamed designer",
        assignedToday: assignedToday.get(r.userId) ?? 0,
        dailyCapacity: r.dailyCapacity,
      }));
    });
  },
);

export type DesignerRow = {
  userId: string;
  name: string;
  /** Manual priority — lower is picked first by auto-assign. */
  rank: number;
  dailyCapacity: number;
  styles: string[];
  /** Orders assigned to this designer since midnight (the daily-limit window). */
  assignedToday: number;
  /** Active work in flight (in_design / awaiting_qc). */
  wipCount: number;
};

/**
 * The ranked designer roster for the Designers page — every active designer with
 * their capacity config and today's load. Ordered by manual rank, then name, so
 * the list reads exactly as the auto-assigner walks it. Staff-only (RLS lets
 * admin/va read all designer profiles).
 */
export async function getDesignerRoster(user: RequestUser): Promise<DesignerRow[]> {
  return withUserContext(user, async (tx) => {
    const roster = await tx
      .select({
        userId: designerProfiles.userId,
        name: users.name,
        rank: designerProfiles.rank,
        dailyCapacity: designerProfiles.dailyCapacity,
        styles: designerProfiles.styles,
      })
      .from(designerProfiles)
      .innerJoin(
        users,
        and(eq(users.id, designerProfiles.userId), eq(users.active, true), eq(users.role, "designer")),
      )
      .orderBy(asc(designerProfiles.rank), asc(users.name));

    if (!roster.length) return [];
    const ids = roster.map((r) => r.userId);

    const assignedToday = new Map<string, number>();
    for (const r of await tx
      .select({ designerId: assignments.designerId, n: sql<number>`count(*)::int` })
      .from(assignments)
      .where(
        and(
          inArray(assignments.designerId, ids),
          gte(assignments.assignedAt, sql`date_trunc('day', now())`),
        ),
      )
      .groupBy(assignments.designerId)) {
      assignedToday.set(r.designerId, Number(r.n));
    }

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

    return roster.map((r) => ({
      userId: r.userId,
      name: r.name ?? "Unnamed designer",
      rank: r.rank,
      dailyCapacity: r.dailyCapacity,
      styles: r.styles ?? [],
      assignedToday: assignedToday.get(r.userId) ?? 0,
      wipCount: wip.get(r.userId) ?? 0,
    }));
  });
}
