import { and, eq, gte, inArray, ne, sql } from "drizzle-orm";
import { cache } from "react";

import { withUserContext, type RequestUser } from "@/lib/db";
import { assignments, designerProfiles, earnings, orders } from "@/lib/db/schema";
import { liveOrderWhere } from "@/lib/orders/archive";
import { getMyWeek, type DesignerWeek } from "@/lib/designers/my-week";
import { DEFAULT_TIMEZONE } from "@/lib/designers/quiet-hours";
import { dayKey, lastDays, sinceDays } from "./shared";

export type DesignerHome = {
  week: DesignerWeek;
  /** My live work by column. */
  board: { queue: number; inDesign: number; revisions: number; awaitingQc: number; withCustomer: number; complete14d: number };
  /** Figures delivered per day, last 14 days. */
  figures: { labels: string[]; values: number[] };
  figures7d: number;
  figuresPrev7d: number;
  /** Limits from the profile (0 = no cap). */
  limits: { maxActive: number; dailyCapacity: number };
  overdue: number;
  dueToday: number;
  assignedToday: number;
};

const load = cache(async (userId: string): Promise<DesignerHome> => {
  const user: RequestUser = { id: userId, role: "designer" };
  const now = new Date();
  // One spare day: the designer's own zone decides which calendar day a row
  // lands on, below, once their profile is read.
  const since15 = sinceDays(15, now);
  const since14 = sinceDays(14, now);

  const [week, db] = await Promise.all([
    getMyWeek(user),
    withUserContext(user, async (tx) => {
      const mine = and(eq(assignments.designerId, userId), eq(assignments.active, true), liveOrderWhere());
      // The designer works to their OWN deadline (assignments.due_at); the
      // customer SLA only stands in for a legacy assignment without one.
      const myDue = sql`coalesce(${assignments.dueAt}, ${orders.dueAt})`;
      const [cols, figRows, limits, openDue, recentAssigned] = await Promise.all([
        tx
          .select({
            queue: sql<number>`count(*) filter (where ${orders.status} = 'ready_to_assign')::int`,
            inDesign: sql<number>`count(*) filter (where ${orders.status} = 'in_design' and ${orders.revisionCount} = 0)::int`,
            revisions: sql<number>`count(*) filter (where ${orders.status} = 'in_design' and ${orders.revisionCount} > 0)::int`,
            awaitingQc: sql<number>`count(*) filter (where ${orders.status} = 'awaiting_qc')::int`,
            // Passed QC, not complete yet (approval, print, delivery).
            withCustomer: sql<number>`count(*) filter (where ${orders.status} in ('awaiting_approval','approved','printing','shipped','delivered'))::int`,
            complete14d: sql<number>`count(*) filter (where ${orders.status} = 'complete' and ${orders.updatedAt} >= ${since14})::int`,
            overdue: sql<number>`count(*) filter (where ${orders.status} in ('ready_to_assign','in_design','awaiting_qc') and ${myDue} < now())::int`,
          })
          .from(assignments)
          .innerJoin(orders, eq(orders.id, assignments.orderId))
          .where(mine),
        // Figures delivered: every earning but a voided one (a cancelled or
        // refunded order), bucketed into the designer's days below.
        tx
          .select({ at: earnings.createdAt, n: earnings.figureCount })
          .from(earnings)
          .where(and(eq(earnings.designerId, userId), ne(earnings.status, "voided"), gte(earnings.createdAt, since15))),
        tx
          .select({ maxActive: designerProfiles.maxActiveOrders, dailyCapacity: designerProfiles.dailyCapacity })
          .from(designerProfiles)
          .where(eq(designerProfiles.userId, userId))
          .limit(1),
        // Deadlines of the work still with the designer: "due today" is
        // counted below in the designer's own zone, like every deadline they see.
        tx
          .select({ dueAt: sql<Date | null>`${myDue}`.mapWith(orders.dueAt) })
          .from(assignments)
          .innerJoin(orders, eq(orders.id, assignments.orderId))
          .where(and(mine, inArray(orders.status, ["ready_to_assign", "in_design", "awaiting_qc"]))),
        // Recent assignments: "Assigned today" is counted in the designer's day too.
        tx
          .select({ at: assignments.assignedAt })
          .from(assignments)
          .innerJoin(orders, eq(orders.id, assignments.orderId))
          .where(and(mine, gte(assignments.assignedAt, sinceDays(2, now)))),
      ]);
      return { cols: cols[0], figRows, lim: limits[0], openDue, recentAssigned };
    }),
  ]);

  // Today in the designer's zone (was Melbourne's: a Jakarta designer saw an
  // order due at 9:30 pm yesterday counted as "due today").
  const zone = week.contact?.timezone || DEFAULT_TIMEZONE;
  const dayIn = (d: Date) => dayKey(d, zone);
  const today = dayIn(now);
  const dueToday = db.openDue.filter((r) => r.dueAt && dayIn(new Date(r.dueAt)) === today).length;
  const assignedToday = db.recentAssigned.filter((r) => r.at && dayIn(new Date(r.at)) === today).length;

  // The chart's days are the designer's own calendar days (was Melbourne's).
  const days14 = lastDays(14, now, zone);
  const perDay = new Map<string, number>();
  for (const r of db.figRows) {
    const key = dayIn(new Date(r.at));
    perDay.set(key, (perDay.get(key) ?? 0) + Number(r.n ?? 0));
  }
  const values = days14.map((d) => perDay.get(d.key) ?? 0);
  const sum = (from: number, to: number) => values.slice(from, to).reduce((a, b) => a + b, 0);
  const c = db.cols;
  return {
    week,
    board: {
      queue: Number(c?.queue ?? 0),
      inDesign: Number(c?.inDesign ?? 0),
      revisions: Number(c?.revisions ?? 0),
      awaitingQc: Number(c?.awaitingQc ?? 0),
      withCustomer: Number(c?.withCustomer ?? 0),
      complete14d: Number(c?.complete14d ?? 0),
    },
    figures: { labels: days14.map((d) => d.label), values },
    figures7d: sum(7, 14),
    figuresPrev7d: sum(0, 7),
    limits: { maxActive: Number(db.lim?.maxActive ?? 0), dailyCapacity: Number(db.lim?.dailyCapacity ?? 0) },
    overdue: Number(c?.overdue ?? 0),
    dueToday,
    assignedToday,
  };
});

export function getDesignerHome(user: RequestUser): Promise<DesignerHome> {
  return load(user.id);
}
