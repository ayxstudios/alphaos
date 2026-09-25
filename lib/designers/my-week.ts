/**
 * "My week" — the designer's own phone-first summary: what they finished this
 * week, on-time rate, revisions, earnings so far, next deadlines, and their
 * own quiet hours. Powers /me for a designer and /designers/[id] for staff
 * looking at one designer. The week starts Monday 00:00 in the DESIGNER'S OWN
 * timezone (never the server's), same as the deadlines they're shown.
 */
import { and, eq, gte, inArray, sql } from "drizzle-orm";

import { withUserContext, type RequestUser, type Tx } from "@/lib/db";
import { activityLog, assignments, earnings, orders, users } from "@/lib/db/schema";
import { liveOrderWhere } from "@/lib/orders/archive";
import { WITH_CUSTOMER_STATUSES } from "@/lib/orders/board-constants";
import { loadDesignerContact, type DesignerContact } from "@/lib/designers/profile";
import { DEFAULT_TIMEZONE, startOfDayInTimezone, startOfWeekInTimezone, formatInTimezone } from "@/lib/designers/quiet-hours";
import { formatDeadline } from "@/lib/time";

export type UpcomingDeadline = {
  orderId: string;
  orderNumber: string;
  status: string;
  dueAt: string | null;
  dueAtLocal: string | null;
};

export type DesignerWeek = {
  designerId: string;
  designerName: string;
  contact: DesignerContact | null;
  weekStartLabel: string;
  ordersDoneThisWeek: number;
  onTimeRate: number | null; // null = no completions this week to judge
  revisionsThisWeek: number;
  earningsThisWeek: number;
  earningsToday: number;
  earningsThisMonth: number;
  activeOrders: number;
  /** Passed QC, not complete yet: with the customer (approval, print, delivery). */
  withCustomer: number;
  upcoming: UpcomingDeadline[];
};

async function loadWeek(tx: Tx, target: string): Promise<DesignerWeek> {
  const [nameRow] = await tx.select({ name: users.name }).from(users).where(eq(users.id, target)).limit(1);
  const contact = await loadDesignerContact(tx, target);
  const now = new Date();
  const weekStart = startOfWeekInTimezone(now, contact?.timezone);
  // "Earned today" is the designer's own day too (the month follows the Money page's period).
  const dayStart = startOfDayInTimezone(now, contact?.timezone);

  // On time = the designer handed the order to QC by THEIR OWN deadline (the
  // assignment's due_at, CLAUDE.md Deadlines), not whether the whole order
  // (customer approval, print, shipping) finished inside the customer SLA.
  // A legacy assignment without a deadline falls back to orders.due_at, and an
  // order with no submission on record is judged by its completion time.
  const ownDeadline = sql`coalesce(${assignments.dueAt}, ${orders.dueAt})`;
  const handedToQcAt = sql`coalesce((select min(${activityLog.createdAt}) from ${activityLog} where ${activityLog.orderId} = ${orders.id} and ${activityLog.toState} = 'awaiting_qc' and ${activityLog.createdAt} >= ${assignments.assignedAt}), ${earnings.createdAt})`;
  const [completedThisWeek] = await tx
    .select({
      total: sql<number>`count(*)::int`,
      onTime: sql<number>`count(*) filter (where ${handedToQcAt} <= ${ownDeadline})::int`,
      judged: sql<number>`count(*) filter (where ${ownDeadline} is not null)::int`,
      revisions: sql<number>`count(*) filter (where ${orders.revisionCount} > 0)::int`,
    })
    .from(earnings)
    .innerJoin(orders, eq(orders.id, earnings.orderId))
    .leftJoin(
      assignments,
      and(eq(assignments.orderId, earnings.orderId), eq(assignments.designerId, target), eq(assignments.active, true)),
    )
    .where(and(eq(earnings.designerId, target), gte(earnings.createdAt, weekStart)));

  const [weekTotal] = await tx
    .select({ total: sql<string>`coalesce(sum(${earnings.amount}), 0)` })
    .from(earnings)
    .where(and(eq(earnings.designerId, target), inArray(earnings.status, ["pending", "paid"]), gte(earnings.createdAt, weekStart)));

  const [dayTotal] = await tx
    .select({ total: sql<string>`coalesce(sum(${earnings.amount}), 0)` })
    .from(earnings)
    .where(
      and(
        eq(earnings.designerId, target),
        inArray(earnings.status, ["pending", "paid"]),
        gte(earnings.createdAt, dayStart),
      ),
    );

  const [monthTotal] = await tx
    .select({ total: sql<string>`coalesce(sum(${earnings.amount}), 0)` })
    .from(earnings)
    .where(
      and(
        eq(earnings.designerId, target),
        inArray(earnings.status, ["pending", "paid"]),
        gte(earnings.createdAt, sql`date_trunc('month', now())`),
      ),
    );

  const myDue = sql<Date | null>`coalesce(${assignments.dueAt}, ${orders.dueAt})`.mapWith(orders.dueAt);
  const activeRows = await tx
    .select({
      orderId: orders.id,
      orderNumber: orders.platformOrderName,
      fallbackNumber: orders.platformOrderId,
      status: orders.status,
      // The designer's OWN deadline (the active assignment), not the customer
      // SLA; a legacy assignment without one falls back to orders.due_at.
      dueAt: myDue,
    })
    .from(orders)
    .innerJoin(assignments, and(eq(assignments.orderId, orders.id), eq(assignments.active, true), eq(assignments.designerId, target)))
    .where(and(inArray(orders.status, ["ready_to_assign", "in_design", "awaiting_qc"]), liveOrderWhere()))
    .orderBy(sql`${myDue} asc nulls last`);

  const [withCustomerRow] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(orders)
    .innerJoin(assignments, and(eq(assignments.orderId, orders.id), eq(assignments.active, true), eq(assignments.designerId, target)))
    .where(and(inArray(orders.status, [...WITH_CUSTOMER_STATUSES]), liveOrderWhere()));

  const judged = Number(completedThisWeek?.judged ?? 0);
  const onTime = Number(completedThisWeek?.onTime ?? 0);

  return {
    designerId: target,
    designerName: nameRow?.name ?? "Designer",
    contact,
    // The day only ("Mon 21 Sept"): the week starts at midnight, so a time adds nothing.
    weekStartLabel: formatInTimezone(weekStart, contact?.timezone, false).replace(/,? \d{1,2}:\d{2}\s?[ap]m$/i, "").replace(",", ""),
    ordersDoneThisWeek: Number(completedThisWeek?.total ?? 0),
    onTimeRate: judged > 0 ? onTime / judged : null,
    revisionsThisWeek: Number(completedThisWeek?.revisions ?? 0),
    earningsThisWeek: Number(weekTotal?.total ?? 0),
    earningsToday: Number(dayTotal?.total ?? 0),
    earningsThisMonth: Number(monthTotal?.total ?? 0),
    activeOrders: activeRows.length,
    withCustomer: Number(withCustomerRow?.n ?? 0),
    upcoming: activeRows.slice(0, 6).map((r) => ({
      orderId: r.orderId,
      orderNumber: r.orderNumber ?? r.fallbackNumber,
      status: r.status,
      dueAt: r.dueAt?.toISOString() ?? null,
      dueAtLocal: r.dueAt ? formatDeadline(r.dueAt, contact?.timezone ?? DEFAULT_TIMEZONE) : null,
    })),
  };
}

/** A designer's own week. */
export async function getMyWeek(user: RequestUser): Promise<DesignerWeek> {
  return withUserContext(user, (tx) => loadWeek(tx, user.id));
}

/** Staff looking at one designer's week (admin/va only — enforced by the caller's page guard + RLS). */
export async function getDesignerWeek(user: RequestUser, designerId: string): Promise<DesignerWeek> {
  return withUserContext(user, (tx) => loadWeek(tx, designerId));
}
