// Role-scoped live numbers for the Alpha chat widget (2026-09-09). The HARD
// rule: a va or designer snapshot must never contain a money/margin/ad-spend
// field or another designer's earnings, so even if a prompt slipped, there
// is nothing in the data to leak. Reuses the same reads the dashboard/board
// already trust (getTodayQueue, getMyWeek) so the numbers Alpha quotes match
// what the person sees on screen; withUserContext keeps every query inside
// this user's own row-level security.
import { and, count, eq, gte, inArray, lt } from "drizzle-orm";

import { withUserContext, type RequestUser } from "@/lib/db";
import { assignments, businesses, orders, printJobs, users, designerProfiles } from "@/lib/db/schema";
import { getTodayQueue } from "@/lib/orders/today-queue";
import { getMyWeek } from "@/lib/designers/my-week";

const DAY = 24 * 3_600_000;

/** Statuses that still need someone's attention (mirrors today-queue's ACTIVE). */
const OPEN_ORDER_STATUSES = [
  "awaiting_details",
  "triage",
  "awaiting_photos",
  "ready_to_assign",
  "in_design",
  "awaiting_qc",
  "awaiting_approval",
  "approved",
  "printing",
  "shipped",
  "fulfillment_only",
] as const;

const IN_FLIGHT_DESIGN_STATUSES = ["ready_to_assign", "in_design", "awaiting_qc"] as const;

export type DesignerLoadRow = { name: string; active: number; capacity: number | null };
export type AlphaSnapshot = Record<string, unknown>;

/**
 * Build the snapshot for whoever is chatting to Alpha right now. Admin gets
 * business-wide operational counts (no dollars); va gets the same Today-queue
 * shape as their own dashboard; designer gets ONLY their own numbers.
 */
export async function buildAlphaSnapshot(user: RequestUser, businessId: string | null): Promise<AlphaSnapshot> {
  if (user.role === "designer") return buildDesignerSnapshot(user);
  if (!businessId) return { role: user.role, note: "no workspace selected" };
  if (user.role === "va") return buildVaSnapshot(user, businessId);
  return buildAdminSnapshot(user, businessId);
}

async function loadDesignerLoad(user: RequestUser, businessId: string): Promise<DesignerLoadRow[]> {
  return withUserContext(user, async (tx) => {
    const rows = await tx
      .select({ designerId: assignments.designerId, name: users.name, capacity: designerProfiles.maxActiveOrders, n: count() })
      .from(assignments)
      .innerJoin(orders, eq(orders.id, assignments.orderId))
      .innerJoin(users, eq(users.id, assignments.designerId))
      .leftJoin(designerProfiles, eq(designerProfiles.userId, assignments.designerId))
      .where(and(eq(assignments.active, true), eq(orders.businessId, businessId), inArray(orders.status, IN_FLIGHT_DESIGN_STATUSES)))
      .groupBy(assignments.designerId, users.name, designerProfiles.maxActiveOrders);
    return rows.map((r) => ({ name: r.name ?? "Designer", active: Number(r.n), capacity: r.capacity ? Number(r.capacity) : null }));
  });
}

async function loadOrdersByStatus(user: RequestUser, businessId: string): Promise<Record<string, number>> {
  return withUserContext(user, async (tx) => {
    const rows = await tx
      .select({ status: orders.status, n: count() })
      .from(orders)
      .where(and(eq(orders.businessId, businessId), inArray(orders.status, OPEN_ORDER_STATUSES)))
      .groupBy(orders.status);
    return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
  });
}

async function buildVaSnapshot(user: RequestUser, businessId: string): Promise<AlphaSnapshot> {
  const [queue, designerLoad, ordersByStatus] = await Promise.all([
    getTodayQueue(user, businessId),
    loadDesignerLoad(user, businessId),
    loadOrdersByStatus(user, businessId),
  ]);
  return {
    role: "va",
    now: queue.counts.now,
    today: queue.counts.today,
    soon: queue.counts.soon,
    totalOpen: queue.counts.total,
    overdue: queue.groups.now.filter((i) => i.kind === "designer_late").length,
    messagesWaiting: queue.groups.now.filter((i) => i.kind === "reply").length,
    designerLoad,
    ordersByStatus,
  };
}

async function buildAdminSnapshot(user: RequestUser, businessId: string): Promise<AlphaSnapshot> {
  const [queue, designerLoad, ordersByStatus, extra] = await Promise.all([
    getTodayQueue(user, businessId),
    loadDesignerLoad(user, businessId),
    loadOrdersByStatus(user, businessId),
    withUserContext(user, async (tx) => {
      const now = new Date();
      const dayAgo = new Date(now.getTime() - DAY);
      const [[newLast24h], [shippedLast24h], [overdue], printRows, bizRows] = await Promise.all([
        tx.select({ n: count() }).from(orders).where(and(eq(orders.businessId, businessId), gte(orders.createdAt, dayAgo))),
        tx
          .select({ n: count() })
          .from(orders)
          .where(and(eq(orders.businessId, businessId), inArray(orders.status, ["shipped", "delivered", "complete"]), gte(orders.updatedAt, dayAgo))),
        tx
          .select({ n: count() })
          .from(orders)
          .where(and(eq(orders.businessId, businessId), lt(orders.dueAt, now), inArray(orders.status, OPEN_ORDER_STATUSES))),
        tx.select({ status: printJobs.status, n: count() }).from(printJobs).where(eq(printJobs.businessId, businessId)).groupBy(printJobs.status),
        tx.select({ name: businesses.name }).from(businesses).where(eq(businesses.id, businessId)).limit(1),
      ]);
      return {
        newLast24h: Number(newLast24h?.n ?? 0),
        shippedLast24h: Number(shippedLast24h?.n ?? 0),
        overdue: Number(overdue?.n ?? 0),
        printJobsByStatus: Object.fromEntries(printRows.map((r) => [r.status ?? "unknown", Number(r.n)])),
        businessName: bizRows[0]?.name ?? null,
      };
    }),
  ]);
  return {
    role: "admin",
    businessName: extra.businessName,
    now: queue.counts.now,
    today: queue.counts.today,
    soon: queue.counts.soon,
    totalOpen: queue.counts.total,
    overdue: extra.overdue,
    newLast24h: extra.newLast24h,
    shippedLast24h: extra.shippedLast24h,
    messagesWaiting: queue.groups.now.filter((i) => i.kind === "reply").length,
    designerLoad,
    ordersByStatus,
    printJobsByStatus: extra.printJobsByStatus,
  };
}

async function buildDesignerSnapshot(user: RequestUser): Promise<AlphaSnapshot> {
  const [week, byStatus] = await Promise.all([
    getMyWeek(user),
    withUserContext(user, async (tx) => {
      const rows = await tx
        .select({ status: orders.status, n: count() })
        .from(assignments)
        .innerJoin(orders, eq(orders.id, assignments.orderId))
        .where(and(eq(assignments.active, true), eq(assignments.designerId, user.id), inArray(orders.status, IN_FLIGHT_DESIGN_STATUSES)))
        .groupBy(orders.status);
      return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
    }),
  ]);
  return {
    role: "designer",
    queueCount: byStatus.ready_to_assign ?? 0,
    inDesignCount: byStatus.in_design ?? 0,
    awaitingQcCount: byStatus.awaiting_qc ?? 0,
    revisionsThisWeek: week.revisionsThisWeek,
    nextDeadlines: week.upcoming.slice(0, 3).map((u) => ({ orderNumber: u.orderNumber, dueAt: u.dueAtLocal ?? u.dueAt })),
    ownEarnedThisWeek: week.earningsThisWeek,
  };
}
