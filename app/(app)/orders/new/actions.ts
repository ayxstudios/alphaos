"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { and, eq, sql } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { withUserContext, type RequestUser } from "@/lib/db";
import { shops, orders, orderItems, customers, assets, activityLog } from "@/lib/db/schema";
import { runAutoAssign } from "@/lib/orders/assign";
import { normalizeOrderNumber } from "@/lib/orders/reconcile";

export type NewOrderInput = {
  orderId: string; // client-minted (also the R2 key namespace)
  shopId: string;
  orderNumber?: string;
  customerName?: string;
  customerEmail?: string;
  figureCount?: number | null;
  style?: string | null;
  productType: "digital" | "physical";
  notes?: string;
  dueAt?: string; // ISO (date)
  r2Keys?: string[];
  photoUrls?: string[];
};

export type NewOrderResult =
  | { ok: true; orderNumber: string; orderId: string }
  | { ok: false; message: string };

async function requireVa(): Promise<RequestUser | { error: NewOrderResult }> {
  const session = await auth();
  const role = session?.user?.role;
  if (!session?.user) return { error: { ok: false, message: "Not signed in" } };
  if (role !== "admin" && role !== "va") {
    return { error: { ok: false, message: "Manual entry is VA/admin only" } };
  }
  return { id: session.user.id, role };
}

function splitName(name: string | undefined): [string | null, string | null] {
  const n = name?.trim();
  if (!n) return [null, null];
  const parts = n.split(/\s+/);
  return parts.length === 1 ? [parts[0], null] : [parts[0], parts.slice(1).join(" ")];
}

/**
 * Create a manual (VA-entered) order. Lands ready_to_assign if any reference
 * photo was attached (R2 upload or pasted URL), else awaiting_photos. source =
 * manual, needs_review off (the VA is entering it deliberately), and it NEVER
 * sends an automated customer email. On ready_to_assign it runs the assignment
 * algorithm immediately (falls to Unassigned if no designer is eligible).
 *
 * The order number is stored on platform_order_name with a `manual:` sentinel
 * platform_order_id, so a later platform import reconciles onto this row instead
 * of duplicating (see reconcileManualOrder).
 */
export async function createManualOrder(input: NewOrderInput): Promise<NewOrderResult> {
  const authed = await requireVa();
  if ("error" in authed) return authed.error;
  const user = authed;

  if (input.productType !== "digital" && input.productType !== "physical") {
    return { ok: false, message: "Choose a product type" };
  }
  const orderId = input.orderId?.trim() || randomUUID();
  const orderNumber = input.orderNumber?.trim() || null;
  const figureCount =
    typeof input.figureCount === "number" && input.figureCount > 0 ? Math.floor(input.figureCount) : null;
  const r2Keys = (input.r2Keys ?? []).filter(Boolean);
  const photoUrls = (input.photoUrls ?? []).map((u) => u.trim()).filter(Boolean);

  try {
    return await withUserContext(user, async (tx) => {
      const [shop] = await tx
        .select({ businessId: shops.businessId, slaConfig: shops.slaConfig })
        .from(shops)
        .where(eq(shops.id, input.shopId));
      if (!shop) return { ok: false as const, message: "Shop not found" };
      const businessId = shop.businessId;

      // Duplicate-number guard (manual OR already-imported) within the shop.
      if (orderNumber) {
        const norm = normalizeOrderNumber(orderNumber);
        const [dup] = await tx
          .select({ id: orders.id })
          .from(orders)
          .where(and(eq(orders.shopId, input.shopId), sql`lower(${orders.platformOrderName}) = ${norm}`))
          .limit(1);
        if (dup) {
          return { ok: false as const, message: `Order ${orderNumber} already exists for this shop.` };
        }
      }

      // Customer (only when an email is supplied — customers require one).
      const email = input.customerEmail?.trim().toLowerCase() || null;
      const [firstName, lastName] = splitName(input.customerName);
      let customerId: string | null = null;
      if (email) {
        await tx
          .insert(customers)
          .values({ businessId, email, firstName, lastName })
          .onConflictDoNothing({ target: [customers.businessId, customers.email] });
        const [c] = await tx
          .select({ id: customers.id })
          .from(customers)
          .where(and(eq(customers.businessId, businessId), eq(customers.email, email)));
        customerId = c?.id ?? null;
      }

      // No email but a name given: keep the name visible via notes.
      let notes = input.notes?.trim() || null;
      if (!email && input.customerName?.trim()) {
        notes = `Customer: ${input.customerName.trim()}${notes ? `\n${notes}` : ""}`;
      }

      const hasPhotos = r2Keys.length + photoUrls.length > 0;
      const status = hasPhotos ? ("ready_to_assign" as const) : ("awaiting_photos" as const);
      const days =
        typeof (shop.slaConfig as { turnaroundDays?: number } | null)?.turnaroundDays === "number"
          ? (shop.slaConfig as { turnaroundDays: number }).turnaroundDays
          : 3;
      const dueAt = input.dueAt ? new Date(input.dueAt) : new Date(Date.now() + days * 86_400_000);
      const platformOrderName = orderNumber;
      const platformOrderId = orderNumber ? `manual:${normalizeOrderNumber(orderNumber)}` : `manual:${orderId}`;

      await tx.insert(orders).values({
        id: orderId,
        businessId,
        shopId: input.shopId,
        customerId,
        platformOrderId,
        platformOrderName,
        status,
        source: "manual",
        placedAt: new Date(),
        dueAt,
        uploadToken: randomUUID(),
        needsReview: false,
        notes,
      });

      await tx.insert(orderItems).values({
        businessId,
        orderId,
        figureCount,
        figureCountSource: figureCount != null ? "manual" : null,
        style: input.style?.trim() || null,
        productType: input.productType,
      });

      const assetRows = [
        ...r2Keys.map((r2Key) => ({
          businessId,
          orderId,
          type: "reference" as const,
          storage: "r2" as const,
          r2Key,
          uploadedBy: user.id,
        })),
        ...photoUrls.map((url) => ({
          businessId,
          orderId,
          type: "reference" as const,
          storage: "cdn" as const,
          url,
          uploadedBy: user.id,
        })),
      ];
      if (assetRows.length) await tx.insert(assets).values(assetRows);

      await tx.insert(activityLog).values({
        businessId,
        orderId,
        actorId: user.id,
        action: "order.created_manual",
        toState: status,
        metadata: { figureCount, style: input.style ?? null, productType: input.productType, photoCount: assetRows.length, orderNumber },
      });

      // Assign immediately when it's ready (falls to Unassigned if none eligible).
      if (status === "ready_to_assign") {
        await runAutoAssign(tx, { orderId, businessId, assignedBy: user.id });
      }

      revalidatePath("/queue");
      revalidatePath("/board");
      revalidatePath("/orders");
      return { ok: true as const, orderNumber: platformOrderName ?? "(no number)", orderId };
    });
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Could not create order" };
  }
}
