import { and, asc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

import { withSystemContext, type Tx } from "@/lib/db";
import {
  assignments,
  activityLog,
  businesses,
  messages,
  notificationFires,
  notifications,
  orders,
  proofs,
  shops,
  users,
} from "@/lib/db/schema";
import { ALERT_TYPES, type AlertType } from "./types";

const HOUR = 60 * 60 * 1000;
const CLOSED_STATUSES = ["delivered", "complete", "cancelled"] as const;
const INTAKE_STATES = ["awaiting_details", "awaiting_photos"] as const;
const SHOP_SYNC_REFIRE_MS = 3 * HOUR;
const ORDER_ESCALATION_REFIRE_MS = 24 * HOUR;

type Recipient = { id: string };

type SweepAlert = {
  businessId: string;
  alertType: AlertType;
  subjectType: "order" | "shop" | "proof" | "message" | "business";
  subjectId: string;
  dedupeKey: string;
  recipients: Recipient[];
  orderId?: string | null;
  title: string;
  body: string;
  href: string;
  metadata?: Record<string, unknown>;
};

export type NotificationSweepResult = {
  candidates: number;
  fired: number;
  skippedDuplicate: number;
  notificationsCreated: number;
};

export type NotificationSweepOptions = {
  businessIds?: string[];
};

function orderLabel(order: { number: string | null; fallback: string }): string {
  return order.number ?? order.fallback;
}

function duration(ms: number): string {
  const totalHours = Math.max(0, Math.floor(ms / HOUR));
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  if (days > 0 && hours > 0) return `${days}d ${hours}h`;
  if (days > 0) return `${days}d`;
  return `${Math.max(1, totalHours)}h`;
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function uniqueRecipients(...groups: Recipient[][]): Recipient[] {
  const seen = new Set<string>();
  const out: Recipient[] = [];
  for (const group of groups) {
    for (const user of group) {
      if (seen.has(user.id)) continue;
      seen.add(user.id);
      out.push(user);
    }
  }
  return out;
}

function escalationWindow(dueAt: Date, now: Date): number {
  return Math.floor(Math.max(0, now.getTime() - dueAt.getTime() - 6 * HOUR) / ORDER_ESCALATION_REFIRE_MS);
}

function shopStaleWindow(staleSince: Date, now: Date): number {
  return Math.floor(Math.max(0, now.getTime() - staleSince.getTime() - HOUR) / SHOP_SYNC_REFIRE_MS);
}

async function fireInApp(tx: Tx, alert: SweepAlert): Promise<{ fired: boolean; notifications: number }> {
  if (alert.recipients.length === 0) return { fired: false, notifications: 0 };

  const [fire] = await tx
    .insert(notificationFires)
    .values({
      businessId: alert.businessId,
      alertType: alert.alertType,
      subjectType: alert.subjectType,
      subjectId: alert.subjectId,
      dedupeKey: alert.dedupeKey,
      metadata: alert.metadata ?? null,
    })
    .onConflictDoNothing({ target: notificationFires.dedupeKey })
    .returning({ id: notificationFires.id });

  if (!fire) return { fired: false, notifications: 0 };

  await tx.insert(notifications).values(
    alert.recipients.map((recipient) => ({
      businessId: alert.businessId,
      userId: recipient.id,
      type: alert.alertType,
      fireId: fire.id,
      orderId: alert.orderId ?? null,
      title: alert.title,
      body: alert.body,
      href: alert.href,
      metadata: alert.metadata ?? null,
    })),
  );

  return { fired: true, notifications: alert.recipients.length };
}

export async function runNotificationSweep(
  now = new Date(),
  opts: NotificationSweepOptions = {},
): Promise<NotificationSweepResult> {
  return withSystemContext(async (tx) => {
    const alerts = await buildAlerts(tx, now, opts);
    const result: NotificationSweepResult = {
      candidates: alerts.length,
      fired: 0,
      skippedDuplicate: 0,
      notificationsCreated: 0,
    };

    for (const alert of alerts) {
      const fired = await fireInApp(tx, alert);
      if (fired.fired) {
        result.fired++;
        result.notificationsCreated += fired.notifications;
      } else {
        result.skippedDuplicate++;
      }
    }

    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        component: "notifications",
        event: "sla_sweep_complete",
        ...result,
      }),
    );
    return result;
  });
}

async function buildAlerts(tx: Tx, now: Date, opts: NotificationSweepOptions): Promise<SweepAlert[]> {
  const [staff, dueSoon, overdue, intakeStale, proofStale, shopStale, unmatchedStale] = await Promise.all([
    loadStaff(tx),
    loadDueSoon(tx, now, opts),
    loadOverdue(tx, now, opts),
    loadIntakeStale(tx, now, opts),
    loadProofStale(tx, now, opts),
    loadShopStale(tx, now, opts),
    loadUnmatchedStale(tx, now, opts),
  ]);

  const alerts: SweepAlert[] = [];

  for (const order of dueSoon) {
    if (!order.dueAt) continue;
    const label = orderLabel(order);
    alerts.push({
      businessId: order.businessId,
      alertType: ALERT_TYPES.orderDueSoon,
      subjectType: "order",
      subjectId: order.id,
      dedupeKey: `order_due_4h:${order.id}`,
      recipients: order.designerId ? [{ id: order.designerId }] : [],
      orderId: order.id,
      title: `${label} is due soon`,
      body: `Due in ${duration(order.dueAt.getTime() - now.getTime())}.`,
      href: `/orders/${order.id}`,
      metadata: { dueAt: order.dueAt.toISOString() },
    });
  }

  for (const order of overdue) {
    if (!order.dueAt) continue;
    const label = orderLabel(order);
    const overdueFor = duration(now.getTime() - order.dueAt.getTime());
    alerts.push({
      businessId: order.businessId,
      alertType: ALERT_TYPES.orderOverdue,
      subjectType: "order",
      subjectId: order.id,
      dedupeKey: `order_overdue:${order.id}`,
      recipients: uniqueRecipients(order.designerId ? [{ id: order.designerId }] : [], staff.vas),
      orderId: order.id,
      title: `${label} is overdue`,
      body: `This order is overdue by ${overdueFor}.`,
      href: `/orders/${order.id}`,
      metadata: { dueAt: order.dueAt.toISOString(), overdueForMs: now.getTime() - order.dueAt.getTime() },
    });

    if (now.getTime() - order.dueAt.getTime() >= 6 * HOUR) {
      const window = escalationWindow(order.dueAt, now);
      alerts.push({
        businessId: order.businessId,
        alertType: ALERT_TYPES.orderOverdueEscalated,
        subjectType: "order",
        subjectId: order.id,
        dedupeKey: `order_overdue_escalated:${order.id}:${window}`,
        recipients: staff.admins,
        orderId: order.id,
        title: `${label} is still overdue`,
        body: `This order has been overdue for ${overdueFor}.`,
        href: `/orders/${order.id}`,
        metadata: {
          dueAt: order.dueAt.toISOString(),
          overdueForMs: now.getTime() - order.dueAt.getTime(),
          refireWindow: window,
        },
      });
    }
  }

  for (const order of intakeStale) {
    const label = orderLabel(order);
    const statusSince = asDate(order.statusSince);
    alerts.push({
      businessId: order.businessId,
      alertType: ALERT_TYPES.orderIntakeStale,
      subjectType: "order",
      subjectId: order.id,
      dedupeKey: `order_intake_48h:${order.id}`,
      recipients: staff.vas,
      orderId: order.id,
      title: `${label} is stuck in intake`,
      body: `This order has been in ${order.status.replaceAll("_", " ")} for ${duration(now.getTime() - statusSince.getTime())}.`,
      href: `/orders/${order.id}`,
      metadata: { status: order.status, statusSince: statusSince.toISOString() },
    });
  }

  for (const proof of proofStale) {
    if (!proof.sentAt) continue;
    const label = orderLabel(proof);
    alerts.push({
      businessId: proof.businessId,
      alertType: ALERT_TYPES.proofNoResponse,
      subjectType: "proof",
      subjectId: proof.proofId,
      dedupeKey: `proof_no_response_72h:${proof.proofId}`,
      recipients: staff.vas,
      orderId: proof.orderId,
      title: `${label} proof has no response`,
      body: `The proof was sent ${duration(now.getTime() - proof.sentAt.getTime())} ago.`,
      href: `/orders/${proof.orderId}`,
      metadata: { proofId: proof.proofId, sentAt: proof.sentAt.toISOString() },
    });
  }

  for (const shop of shopStale) {
    const staleSince = asDate(shop.staleSince);
    const lastSyncAt = shop.lastSyncAt ? asDate(shop.lastSyncAt) : null;
    const staleForMs = now.getTime() - staleSince.getTime();
    const window = shopStaleWindow(staleSince, now);
    alerts.push({
      businessId: shop.businessId,
      alertType: ALERT_TYPES.shopSyncStale,
      subjectType: "shop",
      subjectId: shop.id,
      dedupeKey: `shop_sync_stale:${shop.id}:${staleSince.getTime()}:${window}`,
      recipients: staff.admins,
      title: `${shop.name} sync is stale`,
      body: `Last successful sync was ${duration(staleForMs)} ago.`,
      href: "/dashboard",
      metadata: {
        shopId: shop.id,
        shopName: shop.name,
        lastSyncAt: lastSyncAt?.toISOString() ?? null,
        staleForMs,
        refireWindow: window,
      },
    });
  }

  for (const message of unmatchedStale) {
    alerts.push({
      businessId: message.businessId,
      alertType: ALERT_TYPES.mailUnmatchedReplyStale,
      subjectType: "message",
      subjectId: message.id,
      dedupeKey: `unmatched_reply_24h:${message.id}`,
      recipients: staff.vas,
      title: "Unmatched reply is older than 24h",
      body: `${message.fromAddress ?? "A customer"} has been waiting ${duration(now.getTime() - message.createdAt.getTime())}.`,
      href: "/orders?view=active",
      metadata: { messageId: message.id, createdAt: message.createdAt.toISOString() },
    });
  }

  alerts.push(...(await buildPresenceGapAlerts(tx, now, staff.admins, opts)));

  return alerts;
}

async function loadStaff(tx: Tx): Promise<{ admins: Recipient[]; vas: Recipient[] }> {
  const rows = await tx
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(and(inArray(users.role, ["admin", "va"]), eq(users.active, true)));
  return {
    admins: rows.filter((row) => row.role === "admin").map((row) => ({ id: row.id })),
    vas: rows.filter((row) => row.role === "va").map((row) => ({ id: row.id })),
  };
}

function businessFilter(column: AnyPgColumn, opts: NotificationSweepOptions) {
  return opts.businessIds?.length ? inArray(column, opts.businessIds) : undefined;
}

async function loadDueSoon(tx: Tx, now: Date, opts: NotificationSweepOptions) {
  return tx
    .select({
      id: orders.id,
      businessId: orders.businessId,
      number: orders.platformOrderName,
      fallback: orders.platformOrderId,
      dueAt: orders.dueAt,
      designerId: assignments.designerId,
    })
    .from(orders)
    .innerJoin(assignments, and(eq(assignments.orderId, orders.id), eq(assignments.active, true)))
    .where(
      and(
        sql`${orders.dueAt} is not null`,
        sql`${orders.dueAt} > ${now}`,
        lte(orders.dueAt, new Date(now.getTime() + 4 * HOUR)),
        sql`${orders.status} not in ${CLOSED_STATUSES}`,
        ...(businessFilter(orders.businessId, opts) ? [businessFilter(orders.businessId, opts)!] : []),
      ),
    );
}

async function loadOverdue(tx: Tx, now: Date, opts: NotificationSweepOptions) {
  return tx
    .select({
      id: orders.id,
      businessId: orders.businessId,
      number: orders.platformOrderName,
      fallback: orders.platformOrderId,
      dueAt: orders.dueAt,
      designerId: assignments.designerId,
    })
    .from(orders)
    .leftJoin(assignments, and(eq(assignments.orderId, orders.id), eq(assignments.active, true)))
    .where(
      and(
        sql`${orders.dueAt} is not null`,
        lte(orders.dueAt, now),
        sql`${orders.status} not in ${CLOSED_STATUSES}`,
        ...(businessFilter(orders.businessId, opts) ? [businessFilter(orders.businessId, opts)!] : []),
      ),
    );
}

async function loadIntakeStale(tx: Tx, now: Date, opts: NotificationSweepOptions) {
  const statusSince = sql<Date>`coalesce(
    (select max(${activityLog.createdAt}) from ${activityLog} where ${activityLog.orderId} = ${orders.id} and ${activityLog.toState} = ${orders.status}),
    ${orders.createdAt}
  )`;
  return tx
    .select({
      id: orders.id,
      businessId: orders.businessId,
      number: orders.platformOrderName,
      fallback: orders.platformOrderId,
      status: orders.status,
      statusSince,
    })
    .from(orders)
    .where(
      and(
        inArray(orders.status, [...INTAKE_STATES]),
        lte(statusSince, new Date(now.getTime() - 48 * HOUR)),
        ...(businessFilter(orders.businessId, opts) ? [businessFilter(orders.businessId, opts)!] : []),
      ),
    );
}

async function loadProofStale(tx: Tx, now: Date, opts: NotificationSweepOptions) {
  return tx
    .select({
      proofId: proofs.id,
      businessId: proofs.businessId,
      orderId: proofs.orderId,
      sentAt: messages.sentAt,
      number: orders.platformOrderName,
      fallback: orders.platformOrderId,
    })
    .from(proofs)
    .innerJoin(messages, eq(messages.proofId, proofs.id))
    .innerJoin(orders, eq(orders.id, proofs.orderId))
    .where(
      and(
        isNull(proofs.decision),
        eq(messages.status, "sent"),
        sql`${messages.sentAt} is not null`,
        lte(messages.sentAt, new Date(now.getTime() - 72 * HOUR)),
        ...(businessFilter(proofs.businessId, opts) ? [businessFilter(proofs.businessId, opts)!] : []),
      ),
    )
    .orderBy(asc(messages.sentAt));
}

async function loadShopStale(tx: Tx, now: Date, opts: NotificationSweepOptions) {
  const lastSyncText = sql<string | null>`${shops.integrationConfig}->>${"lastSyncAt"}`;
  const lastSyncAt = sql<Date | null>`nullif(${lastSyncText}, '')::timestamptz`;
  const staleSince = sql<Date>`coalesce(${lastSyncAt}, ${shops.createdAt})`;
  return tx
    .select({
      id: shops.id,
      businessId: shops.businessId,
      name: shops.name,
      lastSyncAt,
      staleSince,
    })
    .from(shops)
    .where(
      and(
        eq(shops.active, true),
        lte(staleSince, new Date(now.getTime() - HOUR)),
        ...(businessFilter(shops.businessId, opts) ? [businessFilter(shops.businessId, opts)!] : []),
      ),
    );
}

async function loadUnmatchedStale(tx: Tx, now: Date, opts: NotificationSweepOptions) {
  return tx
    .select({
      id: messages.id,
      businessId: messages.businessId,
      fromAddress: messages.address,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(
      and(
        eq(messages.direction, "inbound"),
        isNull(messages.orderId),
        isNull(messages.archivedAt),
        lte(messages.createdAt, new Date(now.getTime() - 24 * HOUR)),
        ...(businessFilter(messages.businessId, opts) ? [businessFilter(messages.businessId, opts)!] : []),
      ),
    );
}

async function buildPresenceGapAlerts(
  tx: Tx,
  now: Date,
  admins: Recipient[],
  opts: NotificationSweepOptions,
): Promise<SweepAlert[]> {
  const rows = await tx
    .select({
      businessId: notifications.businessId,
      businessName: businesses.name,
      count: sql<number>`count(distinct ${notifications.userId})::int`,
    })
    .from(notifications)
    .innerJoin(users, eq(users.id, notifications.userId))
    .innerJoin(businesses, eq(businesses.id, notifications.businessId))
    .where(
      and(
        eq(users.role, "designer"),
        eq(users.active, true),
        eq(notifications.type, ALERT_TYPES.orderOverdue),
        isNull(notifications.readAt),
        lte(notifications.createdAt, new Date(now.getTime() - 4 * HOUR)),
        ...(businessFilter(notifications.businessId, opts) ? [businessFilter(notifications.businessId, opts)!] : []),
        sql`not exists (
          select 1
          from notification_channels nc
          where nc.user_id = ${notifications.userId}
            and nc.active = true
            and nc.channel <> 'inapp'
            and (nc.alert_types is null or ${ALERT_TYPES.orderOverdue} = any(nc.alert_types))
        )`,
      ),
    )
    .groupBy(notifications.businessId, businesses.name);

  const window = Math.floor(now.getTime() / (4 * HOUR));
  return rows.map((row) => ({
    businessId: row.businessId,
    alertType: ALERT_TYPES.notificationPresenceGap,
    subjectType: "business" as const,
    subjectId: row.businessId,
    dedupeKey: `presence_gap:${row.businessId}:${window}`,
    recipients: admins,
    title: `${row.count} designer${row.count === 1 ? "" : "s"} have unread required alerts`,
    body: `${row.count} designer${row.count === 1 ? " has" : "s have"} unread overdue alerts older than 4 hours and no external channel.`,
    href: "/dashboard",
    metadata: { count: row.count, businessName: row.businessName, window },
  }));
}
