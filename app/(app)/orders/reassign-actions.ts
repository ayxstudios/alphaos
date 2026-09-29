"use server";

import { and, asc, eq, notInArray, sql } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { withUserContext } from "@/lib/db";
import { assignments, designerBusinesses, orders, users } from "@/lib/db/schema";
import { liveOrderWhere } from "@/lib/orders/archive";
import { bulkReassignOrders } from "@/app/(app)/orders/actions";

export type ReassignOption = { id: string; name: string; openOrders: number; current: boolean };
export type ReassignOptions =
  | { ok: true; orderNumber: string; options: ReassignOption[] }
  | { ok: false; message: string };

const DONE = ["complete", "cancelled", "delivered", "shipped"] as const;

/** The designers who work in this order's business, with how many open orders each one holds. */
export async function loadReassignOptions(orderId: string): Promise<ReassignOptions> {
  const session = await auth();
  const role = session?.user?.role;
  if (!session?.user || (role !== "admin" && role !== "va")) return { ok: false, message: "Only staff can reassign." };
  const user = { id: session.user.id, role };

  return withUserContext(user, async (tx) => {
    const [order] = await tx
      .select({ id: orders.id, businessId: orders.businessId, number: orders.platformOrderName, fallback: orders.platformOrderId })
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);
    if (!order) return { ok: false as const, message: "Order not found." };

    const designers = await tx
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .innerJoin(designerBusinesses, eq(designerBusinesses.userId, users.id))
      .where(and(eq(users.role, "designer"), eq(users.active, true), eq(designerBusinesses.businessId, order.businessId)))
      .orderBy(asc(users.name), asc(users.email));

    const loads = await tx
      .select({ designerId: assignments.designerId, n: sql<number>`count(*)::int` })
      .from(assignments)
      .innerJoin(orders, eq(orders.id, assignments.orderId))
      .where(and(eq(assignments.active, true), eq(assignments.businessId, order.businessId), liveOrderWhere(), notInArray(orders.status, [...DONE])))
      .groupBy(assignments.designerId);
    const load = new Map(loads.map((l) => [l.designerId, l.n]));

    const [current] = await tx
      .select({ designerId: assignments.designerId })
      .from(assignments)
      .where(and(eq(assignments.orderId, orderId), eq(assignments.active, true)))
      .limit(1);

    return {
      ok: true as const,
      orderNumber: order.number ?? order.fallback ?? "Order",
      options: designers.map((d) => ({
        id: d.id,
        name: d.name ?? d.email,
        openOrders: load.get(d.id) ?? 0,
        current: d.id === current?.designerId,
      })),
    };
  });
}

/** One tap: the existing assign path (deactivates the old assignment, writes order.reassigned to the activity log). */
export async function quickReassignOrder(orderId: string, designerId: string): Promise<{ ok: boolean; message: string }> {
  const res = await bulkReassignOrders([orderId], designerId);
  if (!res.ok) return { ok: false, message: res.message };
  const skipped = res.skipped[0]?.reason;
  return skipped ? { ok: false, message: skipped } : { ok: true, message: "Done. New designer set." };
}
