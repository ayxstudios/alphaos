import { and, count, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { cache } from "react";

import { withUserContext, type RequestUser } from "@/lib/db";
import { activityLog, earnings, orders, printJobs, shops } from "@/lib/db/schema";
import { liveOrderWhere } from "@/lib/orders/archive";
import { getTodayQueue, type TodayItem, type TodayKind } from "@/lib/orders/today-queue";
import { getEmailNeedsActionCounts } from "@/lib/email/outbox";
import { getDesignerRoster } from "@/lib/designers/roster";
import { DUE_STATUSES, OPEN_STATUSES, dayBucket, dayKey, fillDays, lastDays, sinceDays, stageCounts, type StageKey } from "./shared";

export type DaySeries = { labels: string[]; values: number[] };

export type StaffHome = {
  businessId: string;
  /** Orders placed, last 14 days by day (oldest first). */
  ordersIn: DaySeries;
  ordersIn7d: number;
  ordersInPrev7d: number;
  /** Orders shipped, last 14 days by day. */
  shipped: DaySeries;
  shipped7d: number;
  shippedPrev7d: number;
  openOrders: number;
  overdue: number;
  dueToday: number;
  /** Share of orders shipped on or before their due date, last 30 days; null when nothing shipped. */
  onTimeRate30d: number | null;
  stages: { key: StageKey; label: string; color: "c3" | "c1" | "c5" | "c4" | "c2"; n: number }[];
  attention: {
    counts: { now: number; today: number; soon: number; total: number };
    byKind: { kind: TodayKind; label: string; n: number }[];
    top: TodayItem[];
    shops: number;
  };
  designers: { id: string; name: string; wip: number; maxActive: number; assignedToday: number; dailyCapacity: number }[];
  shops: { id: string; name: string; platform: string; open: number; overdue: number }[];
  print: { label: string; n: number; color: "c5" | "c2" | "c3" | "c4" }[];
  messages: { unmatched: number; failed: number };
  /** Owner-only. Null for a VA. */
  money: { designerPayMonth: number; designerPayOwed: number } | null;
};

export const KIND_LABEL: Record<TodayKind, string> = {
  reply: "Replies",
  details: "Details",
  proof_silent: "Quiet proofs",
  qc: "QC checks",
  tracking: "Tracking",
  designer_late: "Late designs",
  unassigned: "Unassigned",
  print: "Print",
  triage: "Triage",
  photos_silent: "No photos",
};

const PRINT_GROUPS: { label: string; color: "c5" | "c2" | "c3" | "c4"; match: (s: string) => boolean }[] = [
  { label: "Submitted", color: "c5", match: (s) => /submit|queued|pending|accept|process|printing|in_production/.test(s) },
  { label: "Shipped", color: "c2", match: (s) => /ship|deliver|complete|fulfil/.test(s) },
  { label: "Needs action", color: "c3", match: (s) => /manual|draft|hold|unmatched|missing/.test(s) },
  { label: "Failed", color: "c4", match: (s) => /fail|reject|error|cancel/.test(s) },
];

const load = cache(async (userId: string, role: RequestUser["role"], businessId: string): Promise<StaffHome> => {
  const user: RequestUser = { id: userId, role };
  const now = new Date();
  const days14 = lastDays(14, now);
  const since14 = sinceDays(14, now);
  const since30 = sinceDays(30, now);
  const todayKey = dayKey(now);
  const monthStart = new Date(new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Melbourne", year: "numeric", month: "2-digit" }).format(now) + "-01T00:00:00+10:00");

  const [queue, mail, roster, db] = await Promise.all([
    getTodayQueue(user, businessId, now),
    getEmailNeedsActionCounts(user, { businessId }).catch(() => ({ unmatched: 0, failed: 0 })),
    getDesignerRoster(user).catch(() => []),
    withUserContext(user, async (tx) => {
      const live = and(eq(orders.businessId, businessId), liveOrderWhere());
      const placedAt = sql`coalesce(${orders.placedAt}, ${orders.createdAt})`;
      const [byStatus, inRows, shipLogRows, shipOrderRows, dueRows, onTime, onTimeFallback, shopRows, printRows, money] = await Promise.all([
        tx.select({ status: orders.status, n: count() }).from(orders).where(live).groupBy(orders.status),
        tx
          .select({ day: dayBucket(placedAt), n: count() })
          .from(orders)
          .where(and(live, gte(placedAt, since14)))
          .groupBy(dayBucket(placedAt)),
        tx
          .select({ day: dayBucket(activityLog.createdAt), n: count() })
          .from(activityLog)
          .where(and(eq(activityLog.businessId, businessId), eq(activityLog.toState, "shipped"), gte(activityLog.createdAt, since14)))
          .groupBy(dayBucket(activityLog.createdAt)),
        // Fallback when nothing has logged a transition yet (imported or seeded
        // history): orders already in a shipped state, by their last update.
        tx
          .select({ day: dayBucket(orders.updatedAt), n: count() })
          .from(orders)
          .where(and(live, inArray(orders.status, ["shipped", "delivered", "complete"]), gte(orders.updatedAt, since14)))
          .groupBy(dayBucket(orders.updatedAt)),
        tx
          .select({
            overdue: sql<number>`count(*) filter (where ${orders.dueAt} < now())::int`,
            dueToday: sql<number>`count(*) filter (where ${dayBucket(orders.dueAt)} = ${todayKey})::int`,
          })
          .from(orders)
          .where(and(live, isNotNull(orders.dueAt), inArray(orders.status, DUE_STATUSES))),
        tx
          .select({
            judged: sql<number>`count(*) filter (where ${orders.dueAt} is not null)::int`,
            onTime: sql<number>`count(*) filter (where ${orders.dueAt} is not null and ${activityLog.createdAt} <= ${orders.dueAt})::int`,
          })
          .from(activityLog)
          .innerJoin(orders, eq(orders.id, activityLog.orderId))
          .where(and(eq(activityLog.businessId, businessId), eq(activityLog.toState, "shipped"), gte(activityLog.createdAt, since30))),
        tx
          .select({
            judged: sql<number>`count(*) filter (where ${orders.dueAt} is not null)::int`,
            onTime: sql<number>`count(*) filter (where ${orders.dueAt} is not null and ${orders.updatedAt} <= ${orders.dueAt})::int`,
          })
          .from(orders)
          .where(and(live, inArray(orders.status, ["shipped", "delivered", "complete"]), gte(orders.updatedAt, since30))),
        tx
          .select({
            id: shops.id,
            name: shops.name,
            platform: shops.platform,
            open: sql<number>`count(${orders.id}) filter (where ${inArray(orders.status, OPEN_STATUSES)} and ${orders.archivedAt} is null)::int`,
            overdue: sql<number>`count(${orders.id}) filter (where ${inArray(orders.status, DUE_STATUSES)} and ${orders.archivedAt} is null and ${orders.dueAt} < now())::int`,
          })
          .from(shops)
          .leftJoin(orders, eq(orders.shopId, shops.id))
          .where(and(eq(shops.businessId, businessId), eq(shops.active, true)))
          .groupBy(shops.id, shops.name, shops.platform)
          .orderBy(shops.name),
        tx
          .select({ status: printJobs.status, n: count() })
          .from(printJobs)
          .where(and(eq(printJobs.businessId, businessId), gte(printJobs.createdAt, since30)))
          .groupBy(printJobs.status),
        role === "admin"
          ? tx
              .select({
                month: sql<string>`coalesce(sum(${earnings.amount}) filter (where ${earnings.status} in ('pending','paid') and ${earnings.createdAt} >= ${monthStart}), 0)`,
                owed: sql<string>`coalesce(sum(${earnings.amount}) filter (where ${earnings.status} = 'pending'), 0)`,
              })
              .from(earnings)
              .where(eq(earnings.businessId, businessId))
          : Promise.resolve([{ month: "0", owed: "0" }]),
      ]);
      const shipRows = shipLogRows.length > 0 ? shipLogRows : shipOrderRows;
      // On time only from real transitions: the updated_at proxy is not honest.
      const onTimeRow = onTime[0];
      void onTimeFallback;
      return { byStatus, inRows, shipRows, due: dueRows[0], onTime: onTimeRow, shopRows, printRows, money: money[0] };
    }),
  ]);

  const inValues = fillDays(days14, db.inRows);
  const shipValues = fillDays(days14, db.shipRows);
  const sum = (a: number[], from: number, to: number) => a.slice(from, to).reduce((x, y) => x + y, 0);
  const statusRows = db.byStatus.map((r) => ({ status: r.status, n: Number(r.n) }));
  const openOrders = statusRows.filter((r) => (OPEN_STATUSES as string[]).includes(r.status)).reduce((a, r) => a + r.n, 0);

  const kindCounts = new Map<TodayKind, number>();
  for (const it of queue.items) kindCounts.set(it.kind, (kindCounts.get(it.kind) ?? 0) + 1);
  const byKind = (Object.keys(KIND_LABEL) as TodayKind[])
    .map((kind) => ({ kind, label: KIND_LABEL[kind], n: kindCounts.get(kind) ?? 0 }))
    .filter((k) => k.n > 0)
    .sort((a, b) => b.n - a.n);

  const printGroups = PRINT_GROUPS.map((g) => ({ label: g.label, color: g.color, n: 0 }));
  for (const r of db.printRows) {
    const s = String(r.status ?? "").toLowerCase();
    const idx = PRINT_GROUPS.findIndex((g) => g.match(s));
    printGroups[idx >= 0 ? idx : 2].n += Number(r.n);
  }

  return {
    businessId,
    ordersIn: { labels: days14.map((d) => d.label), values: inValues },
    ordersIn7d: sum(inValues, 7, 14),
    ordersInPrev7d: sum(inValues, 0, 7),
    shipped: { labels: days14.map((d) => d.label), values: shipValues },
    shipped7d: sum(shipValues, 7, 14),
    shippedPrev7d: sum(shipValues, 0, 7),
    openOrders,
    overdue: Number(db.due?.overdue ?? 0),
    dueToday: Number(db.due?.dueToday ?? 0),
    onTimeRate30d: db.onTime && Number(db.onTime.judged) > 0 ? Math.round((Number(db.onTime.onTime) / Number(db.onTime.judged)) * 100) : null,
    stages: stageCounts(statusRows),
    attention: {
      counts: queue.counts,
      byKind,
      top: queue.items.slice(0, 5),
      shops: queue.shops,
    },
    designers: roster.map((d) => ({
      id: d.userId,
      name: d.name,
      wip: d.wipCount,
      maxActive: d.maxActiveOrders,
      assignedToday: d.assignedToday,
      dailyCapacity: d.dailyCapacity,
    })),
    shops: db.shopRows.map((s) => ({ id: s.id, name: s.name, platform: s.platform, open: Number(s.open), overdue: Number(s.overdue) })),
    print: printGroups,
    messages: { unmatched: mail.unmatched, failed: mail.failed },
    money: role === "admin" ? { designerPayMonth: Number(db.money?.month ?? 0), designerPayOwed: Number(db.money?.owed ?? 0) } : null,
  };
});

/** Home numbers for an admin or VA in one business. One transaction, parallel queries, request-cached. */
export function getStaffHome(user: RequestUser, businessId: string): Promise<StaffHome> {
  return load(user.id, user.role, businessId);
}
