import { and, eq, gte, sql } from "drizzle-orm";
import { cache } from "react";

import { withUserContext, type RequestUser } from "@/lib/db";
import { assignments, designerProfiles, earnings, orders } from "@/lib/db/schema";
import { liveOrderWhere } from "@/lib/orders/archive";
import { getMyWeek, type DesignerWeek } from "@/lib/designers/my-week";
import { dayBucket, fillDays, lastDays, sinceDays } from "./shared";

export type DesignerHome = {
  week: DesignerWeek;
  /** My live work by column. */
  board: { queue: number; inDesign: number; revisions: number; awaitingQc: number; complete14d: number };
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
  const days14 = lastDays(14, now);
  const since14 = sinceDays(14, now);

  const [week, db] = await Promise.all([
    getMyWeek(user),
    withUserContext(user, async (tx) => {
      const mine = and(eq(assignments.designerId, userId), eq(assignments.active, true), liveOrderWhere());
      const [cols, figRows, limits] = await Promise.all([
        tx
          .select({
            queue: sql<number>`count(*) filter (where ${orders.status} = 'ready_to_assign')::int`,
            inDesign: sql<number>`count(*) filter (where ${orders.status} = 'in_design' and ${orders.revisionCount} = 0)::int`,
            revisions: sql<number>`count(*) filter (where ${orders.status} = 'in_design' and ${orders.revisionCount} > 0)::int`,
            awaitingQc: sql<number>`count(*) filter (where ${orders.status} = 'awaiting_qc')::int`,
            complete14d: sql<number>`count(*) filter (where ${orders.status} = 'complete' and ${orders.updatedAt} >= ${since14})::int`,
            overdue: sql<number>`count(*) filter (where ${orders.status} in ('ready_to_assign','in_design','awaiting_qc') and ${orders.dueAt} < now())::int`,
            dueToday: sql<number>`count(*) filter (where ${orders.status} in ('ready_to_assign','in_design','awaiting_qc') and ${dayBucket(orders.dueAt)} = to_char(timezone('Australia/Melbourne', now()), 'YYYY-MM-DD'))::int`,
            assignedToday: sql<number>`count(*) filter (where ${dayBucket(assignments.assignedAt)} = to_char(timezone('Australia/Melbourne', now()), 'YYYY-MM-DD'))::int`,
          })
          .from(assignments)
          .innerJoin(orders, eq(orders.id, assignments.orderId))
          .where(mine),
        tx
          .select({ day: dayBucket(earnings.createdAt), n: sql<number>`coalesce(sum(${earnings.figureCount}), 0)::int` })
          .from(earnings)
          .where(and(eq(earnings.designerId, userId), gte(earnings.createdAt, since14)))
          .groupBy(dayBucket(earnings.createdAt)),
        tx
          .select({ maxActive: designerProfiles.maxActiveOrders, dailyCapacity: designerProfiles.dailyCapacity })
          .from(designerProfiles)
          .where(eq(designerProfiles.userId, userId))
          .limit(1),
      ]);
      return { cols: cols[0], figRows, lim: limits[0] };
    }),
  ]);

  const values = fillDays(days14, db.figRows);
  const sum = (from: number, to: number) => values.slice(from, to).reduce((a, b) => a + b, 0);
  const c = db.cols;
  return {
    week,
    board: {
      queue: Number(c?.queue ?? 0),
      inDesign: Number(c?.inDesign ?? 0),
      revisions: Number(c?.revisions ?? 0),
      awaitingQc: Number(c?.awaitingQc ?? 0),
      complete14d: Number(c?.complete14d ?? 0),
    },
    figures: { labels: days14.map((d) => d.label), values },
    figures7d: sum(7, 14),
    figuresPrev7d: sum(0, 7),
    limits: { maxActive: Number(db.lim?.maxActive ?? 0), dailyCapacity: Number(db.lim?.dailyCapacity ?? 0) },
    overdue: Number(c?.overdue ?? 0),
    dueToday: Number(c?.dueToday ?? 0),
    assignedToday: Number(c?.assignedToday ?? 0),
  };
});

export function getDesignerHome(user: RequestUser): Promise<DesignerHome> {
  return load(user.id);
}
