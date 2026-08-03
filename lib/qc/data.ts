import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import { withUserContext, type RequestUser } from "@/lib/db";
import {
  orders,
  orderItems,
  assignments,
  assets,
  customers,
  shops,
  users,
  activityLog,
} from "@/lib/db/schema";
import type { OrderStatus } from "@/lib/orders/transitions";
import { resolveChecklist, type ChecklistSnapshot } from "./checklist";

export type QcImage = {
  id: string;
  url: string | null;
};

export type QcVersion = {
  id: string;
  url: string | null;
  /** "submission" | "final" */
  type: string;
  uploadedBy: string | null;
  createdAt: string; // ISO
};

export type QcContext = {
  orderId: string;
  orderNumber: string;
  status: OrderStatus;
  /** True only when the order is still awaiting_qc (Pass/Fail are legal). */
  isReviewable: boolean;
  customerName: string;
  figureCount: number;
  figuresResolved: boolean;
  style: string | null;
  designerName: string | null;
  /** When the order entered awaiting_qc (ISO), for the "time in QC" clock. */
  enteredQcAt: string | null;
  dueAt: string | null;
  references: QcImage[];
  versions: QcVersion[]; // oldest → newest
  checklist: ChecklistSnapshot;
};

const SUBMISSION_TYPES = ["submission", "final"] as const;

/**
 * Full context for the QC screen. VA/admin only — reads the customers table
 * directly (designers never reach this route). RLS still scopes every query.
 */
export async function getQcContext(
  user: RequestUser,
  orderId: string,
): Promise<QcContext | null> {
  return withUserContext(user, async (tx) => {
    const [order] = await tx
      .select({
        id: orders.id,
        platformOrderId: orders.platformOrderId,
        platformOrderName: orders.platformOrderName,
        status: orders.status,
        businessId: orders.businessId,
        shopId: orders.shopId,
        customerId: orders.customerId,
        dueAt: orders.dueAt,
      })
      .from(orders)
      .where(eq(orders.id, orderId));
    if (!order) return null;

    const [shop] = await tx
      .select({
        checklistVersion: shops.checklistVersion,
        integrationConfig: shops.integrationConfig,
      })
      .from(shops)
      .where(eq(shops.id, order.shopId));

    // Figure count + style.
    const items = await tx
      .select({ figureCount: orderItems.figureCount, style: orderItems.style })
      .from(orderItems)
      .where(eq(orderItems.orderId, orderId));
    let figureCount = 0;
    let figuresResolved = true;
    let style: string | null = null;
    for (const it of items) {
      figureCount += it.figureCount ?? 0;
      if (it.figureCount == null) figuresResolved = false;
      if (it.style && !style) style = it.style;
    }

    // Customer (staff-only route).
    let customerName = "—";
    if (order.customerId) {
      const [c] = await tx
        .select({ firstName: customers.firstName, lastName: customers.lastName })
        .from(customers)
        .where(eq(customers.id, order.customerId));
      if (c) customerName = [c.firstName, c.lastName].filter(Boolean).join(" ") || "—";
    }

    // Active designer.
    const [designer] = await tx
      .select({ name: users.name, email: users.email })
      .from(assignments)
      .innerJoin(users, eq(users.id, assignments.designerId))
      .where(and(eq(assignments.orderId, orderId), eq(assignments.active, true)));
    const designerName = designer ? (designer.name ?? designer.email) : null;

    // When it entered QC (most recent transition into awaiting_qc).
    const [qcEntry] = await tx
      .select({ createdAt: activityLog.createdAt })
      .from(activityLog)
      .where(and(eq(activityLog.orderId, orderId), eq(activityLog.toState, "awaiting_qc")))
      .orderBy(desc(activityLog.createdAt))
      .limit(1);

    // Reference photos (left pane).
    const references = await tx
      .select({ id: assets.id, url: assets.url })
      .from(assets)
      .where(and(eq(assets.orderId, orderId), eq(assets.type, "reference")))
      .orderBy(asc(assets.createdAt));

    // Delivered versions (right pane + history strip), oldest first.
    const versionRows = await tx
      .select({
        id: assets.id,
        url: assets.url,
        type: assets.type,
        createdAt: assets.createdAt,
        uploadedByName: users.name,
        uploadedByEmail: users.email,
      })
      .from(assets)
      .leftJoin(users, eq(users.id, assets.uploadedBy))
      .where(and(eq(assets.orderId, orderId), inArray(assets.type, [...SUBMISSION_TYPES])))
      .orderBy(asc(assets.createdAt));

    const versions: QcVersion[] = versionRows.map((v) => ({
      id: v.id,
      url: v.url,
      type: v.type,
      uploadedBy: v.uploadedByName ?? v.uploadedByEmail ?? null,
      createdAt: v.createdAt.toISOString(),
    }));

    return {
      orderId: order.id,
      orderNumber: order.platformOrderName ?? order.platformOrderId,
      status: order.status,
      isReviewable: order.status === "awaiting_qc",
      customerName,
      figureCount,
      figuresResolved,
      style,
      designerName,
      enteredQcAt: qcEntry ? qcEntry.createdAt.toISOString() : null,
      dueAt: order.dueAt ? order.dueAt.toISOString() : null,
      references: references.map((r) => ({ id: r.id, url: r.url })),
      versions,
      checklist: resolveChecklist({
        checklistVersion: shop?.checklistVersion ?? 1,
        integrationConfig: shop?.integrationConfig ?? null,
      }),
    };
  });
}

/**
 * Ordered ids of every order currently awaiting QC — drives J/K navigation and
 * auto-advance to the next order after a decision. Same ordering as the VA
 * "Awaiting QC" queue (soonest SLA first).
 */
export async function getQcQueueIds(
  user: RequestUser,
  businessId: string | null,
): Promise<string[]> {
  return withUserContext(user, async (tx) => {
    const bizFilter =
      businessId && businessId !== "all" ? eq(orders.businessId, businessId) : undefined;

    const rows = await tx
      .select({ id: orders.id })
      .from(orders)
      .where(
        bizFilter
          ? and(eq(orders.status, "awaiting_qc"), bizFilter)
          : eq(orders.status, "awaiting_qc"),
      )
      // NULL due dates sort last, then oldest in QC first.
      .orderBy(sql`${orders.dueAt} asc nulls last`, asc(orders.createdAt));

    return rows.map((r) => r.id);
  });
}
