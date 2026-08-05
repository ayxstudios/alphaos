"use server";

import { revalidatePath } from "next/cache";
import { and, eq, inArray } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { withUserContext, type RequestUser } from "@/lib/db";
import {
  activityLog,
  assignments,
  designerBusinesses,
  orders,
  users,
} from "@/lib/db/schema";
import {
  transition,
  OrderTransitionError,
  type OrderStatus,
} from "@/lib/orders/transitions";
import { addComment } from "@/lib/orders/card-detail";

type BulkSkipped = {
  orderId: string;
  orderNumber: string;
  reason: string;
};

export type BulkActionResult =
  | { ok: true; changed: number; skipped: BulkSkipped[] }
  | { ok: false; message: string };

export type CommentResult =
  | { ok: true }
  | { ok: false; message: string };

const REASSIGNABLE_STATUSES = new Set<OrderStatus>([
  "ready_to_assign",
  "in_design",
  "awaiting_qc",
]);

async function requireStaff(): Promise<RequestUser | { error: string }> {
  const session = await auth();
  const role = session?.user?.role;
  if (!session?.user || (role !== "admin" && role !== "va")) {
    return { error: "Only admin and VAs can manage orders." };
  }
  return { id: session.user.id, role };
}

function cleanOrderIds(orderIds: string[]) {
  return [...new Set(orderIds.map((id) => id.trim()).filter(Boolean))].slice(0, 100);
}

export async function bulkChangeOrderStatus(
  orderIds: string[],
  to: OrderStatus,
): Promise<BulkActionResult> {
  const user = await requireStaff();
  if ("error" in user) return { ok: false, message: user.error };
  const ids = cleanOrderIds(orderIds);
  if (!ids.length) return { ok: false, message: "Select at least one order." };

  const visibleOrders = await withUserContext(user, (tx) =>
    tx
      .select({
        id: orders.id,
        status: orders.status,
        number: orders.platformOrderName,
        fallbackNumber: orders.platformOrderId,
      })
      .from(orders)
      .where(inArray(orders.id, ids)),
  );
  const visible = new Map(visibleOrders.map((order) => [order.id, order]));
  const skipped: BulkSkipped[] = [];
  let changed = 0;

  for (const id of ids) {
    const order = visible.get(id);
    if (!order) {
      skipped.push({ orderId: id, orderNumber: id, reason: "Not visible or no longer exists." });
      continue;
    }

    try {
      await transition(user, {
        orderId: order.id,
        to,
        expectedFrom: order.status,
        metadata: { via: "bulk_orders_dashboard" },
      });
      changed += 1;
    } catch (err) {
      if (err instanceof OrderTransitionError) {
        skipped.push({
          orderId: order.id,
          orderNumber: order.number ?? order.fallbackNumber,
          reason: err.message,
        });
        continue;
      }
      throw err;
    }
  }

  revalidatePath("/orders");
  revalidatePath("/board");
  return { ok: true, changed, skipped };
}

export async function bulkReassignOrders(
  orderIds: string[],
  designerId: string,
): Promise<BulkActionResult> {
  const user = await requireStaff();
  if ("error" in user) return { ok: false, message: user.error };
  const ids = cleanOrderIds(orderIds);
  if (!ids.length) return { ok: false, message: "Select at least one order." };
  if (!designerId) return { ok: false, message: "Choose a designer." };

  const result = await withUserContext(user, async (tx) => {
    const [designer] = await tx
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(and(eq(users.id, designerId), eq(users.role, "designer"), eq(users.active, true)))
      .limit(1);
    if (!designer) return { ok: false as const, message: "Designer not found or inactive." };

    const visibleOrders = await tx
      .select({
        id: orders.id,
        businessId: orders.businessId,
        status: orders.status,
        number: orders.platformOrderName,
        fallbackNumber: orders.platformOrderId,
      })
      .from(orders)
      .where(inArray(orders.id, ids));

    const memberships = await tx
      .select({ businessId: designerBusinesses.businessId })
      .from(designerBusinesses)
      .where(eq(designerBusinesses.userId, designerId));
    const designerBusinessesSet = new Set(memberships.map((row) => row.businessId));
    const visible = new Map(visibleOrders.map((order) => [order.id, order]));
    const skipped: BulkSkipped[] = [];
    let changed = 0;

    for (const id of ids) {
      const order = visible.get(id);
      if (!order) {
        skipped.push({ orderId: id, orderNumber: id, reason: "Not visible or no longer exists." });
        continue;
      }
      const number = order.number ?? order.fallbackNumber;
      if (!REASSIGNABLE_STATUSES.has(order.status)) {
        skipped.push({ orderId: id, orderNumber: number, reason: `Cannot assign while ${order.status}.` });
        continue;
      }
      if (!designerBusinessesSet.has(order.businessId)) {
        skipped.push({ orderId: id, orderNumber: number, reason: "Designer does not work in this order's business." });
        continue;
      }

      await tx
        .update(assignments)
        .set({ active: false })
        .where(and(eq(assignments.orderId, order.id), eq(assignments.active, true)));
      await tx.insert(assignments).values({
        businessId: order.businessId,
        orderId: order.id,
        designerId,
        assignedBy: user.id,
        dueAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        active: true,
      });
      await tx.insert(activityLog).values({
        businessId: order.businessId,
        orderId: order.id,
        actorId: user.id,
        action: "order.reassigned",
        metadata: { designerId, via: "bulk_orders_dashboard" },
      });
      changed += 1;
    }

    return { ok: true as const, changed, skipped };
  });

  if (!result.ok) return result;
  revalidatePath("/orders");
  revalidatePath("/board");
  return result;
}

export async function addOrderComment(orderId: string, body: string): Promise<CommentResult> {
  const user = await requireStaff();
  if ("error" in user) return { ok: false, message: user.error };
  const text = body.trim();
  if (!orderId || !text) return { ok: false, message: "Write a note first." };
  if (text.length > 2000) return { ok: false, message: "Notes must be 2,000 characters or fewer." };

  await addComment(user, orderId, text);
  revalidatePath(`/orders/${orderId}`);
  revalidatePath("/orders");
  return { ok: true };
}
