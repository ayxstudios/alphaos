"use server";

import { revalidatePath } from "next/cache";
import { and, eq, inArray } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { withUserContext, type RequestUser } from "@/lib/db";
import {
  activityLog,
  assignments,
  designerBusinesses,
  orderItems,
  orders,
  printJobs,
  users,
} from "@/lib/db/schema";
import { getShopCredentials } from "@/lib/db/credentials";
import {
  transition,
  runTransition,
  OrderTransitionError,
  type OrderStatus,
} from "@/lib/orders/transitions";
import { addComment } from "@/lib/orders/card-detail";
import {
  freshShopifyCredentials,
  fulfillShopifyOrderWithTracking,
  type ShopifyCredentials,
  type ShopifyFulfillmentResult,
} from "@/lib/integrations/shopify";

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

export type TrackingCompleteResult =
  | { ok: true; message: string; closeWarning?: string | null }
  | { ok: false; message: string };

export type TrackingCompleteInput = {
  orderId: string;
  provider: "gelato" | "lumaprints";
  trackingNumber: string;
  trackingCompany?: string;
  trackingUrl?: string;
  notifyCustomer?: boolean;
};

const REASSIGNABLE_STATUSES = new Set<OrderStatus>([
  "awaiting_details",
  "awaiting_photos",
  "ready_to_assign",
  "in_design",
  "awaiting_qc",
  "awaiting_approval",
  "approved",
  "printing",
  "shipped",
  "delivered",
  "complete",
  "on_hold",
  "triage",
  "fulfillment_only",
]);

const REVISION_FROM_STATUSES = new Set<OrderStatus>([
  "awaiting_approval",
  "approved",
  "printing",
  "shipped",
  "delivered",
  "complete",
]);

const TRACKING_COMPLETION_PATHS: Partial<Record<OrderStatus, OrderStatus[]>> = {
  approved: ["printing", "shipped", "delivered", "complete"],
  printing: ["shipped", "delivered", "complete"],
  shipped: ["delivered", "complete"],
  delivered: ["complete"],
  fulfillment_only: ["complete"],
  complete: [],
};

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

function cleanOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function cleanTrackingUrl(value: string | undefined): string | undefined | { error: string } {
  const trimmed = cleanOptional(value);
  if (!trimmed) return undefined;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return { error: "Tracking URL must start with http:// or https://." };
    }
    return url.toString();
  } catch {
    return { error: "Tracking URL is not valid." };
  }
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

export async function createOrderRevision(
  orderId: string,
  body: string,
): Promise<CommentResult> {
  const user = await requireStaff();
  if ("error" in user) return { ok: false, message: user.error };
  const note = body.trim();
  if (!orderId || !note) return { ok: false, message: "Write the revision request first." };
  if (note.length > 2000) return { ok: false, message: "Revision notes must be 2,000 characters or fewer." };

  const [order] = await withUserContext(user, (tx) =>
    tx
      .select({
        id: orders.id,
        status: orders.status,
        number: orders.platformOrderName,
        fallbackNumber: orders.platformOrderId,
      })
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1),
  );
  if (!order) return { ok: false, message: "Order not found." };
  if (!REVISION_FROM_STATUSES.has(order.status)) {
    return {
      ok: false,
      message: `Cannot create a revision while this order is ${order.status.replace(/_/g, " ")}.`,
    };
  }

  try {
    await transition(user, {
      orderId,
      to: "in_design",
      expectedFrom: order.status,
      metadata: {
        via: "va_created_revision",
        revisionReason: note,
        orderNumber: order.number ?? order.fallbackNumber,
      },
    });
  } catch (err) {
    if (err instanceof OrderTransitionError) return { ok: false, message: err.message };
    throw err;
  }

  revalidatePath(`/orders/${orderId}`);
  revalidatePath("/orders");
  revalidatePath("/board");
  return { ok: true };
}

export async function addTrackingAndCompleteOrder(
  input: TrackingCompleteInput,
): Promise<TrackingCompleteResult> {
  const user = await requireStaff();
  if ("error" in user) return { ok: false, message: user.error };

  const orderId = input.orderId.trim();
  const trackingNumber = input.trackingNumber.trim();
  const trackingCompany = cleanOptional(input.trackingCompany);
  const trackingUrl = cleanTrackingUrl(input.trackingUrl);
  if (!orderId) return { ok: false, message: "Order is required." };
  if (!trackingNumber) return { ok: false, message: "Tracking number is required." };
  if (input.provider !== "gelato" && input.provider !== "lumaprints") {
    return { ok: false, message: "Choose a valid print provider." };
  }
  if (typeof trackingUrl === "object") return { ok: false, message: trackingUrl.error };

  const snapshot = await withUserContext(user, async (tx) => {
    const [order] = await tx
      .select({
        id: orders.id,
        businessId: orders.businessId,
        shopId: orders.shopId,
        source: orders.source,
        status: orders.status,
        platformOrderId: orders.platformOrderId,
        platformOrderName: orders.platformOrderName,
      })
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);

    if (!order) return null;
    const items = await tx
      .select({
        productType: orderItems.productType,
        figureCount: orderItems.figureCount,
      })
      .from(orderItems)
      .where(eq(orderItems.orderId, orderId));
    const credentials =
      order.source === "shopify"
        ? ((await getShopCredentials(tx, order.shopId)) as ShopifyCredentials)
        : null;
    return { order, items, credentials };
  });

  if (!snapshot) return { ok: false, message: "Order not found." };
  const { order, items } = snapshot;
  const hasPhysicalItem = items.some((item) => item.productType === "physical");
  if (!hasPhysicalItem) {
    return { ok: false, message: "Tracking can only be added to physical orders." };
  }
  if (!(order.status in TRACKING_COMPLETION_PATHS)) {
    return {
      ok: false,
      message: `Order must be approved, in print, shipped, delivered, fulfillment-only, or complete before adding final tracking.`,
    };
  }
  if (order.status !== "fulfillment_only" && order.status !== "complete") {
    const unresolvedFigures = items.some((item) => item.figureCount == null);
    if (unresolvedFigures) {
      return {
        ok: false,
        message: "Resolve figure counts before completing this order. Figure count drives payout.",
      };
    }
  }

  let shopifyResult: ShopifyFulfillmentResult | null = null;
  if (order.source === "shopify") {
    try {
      const freshCredentials = await freshShopifyCredentials(snapshot.credentials!);
      shopifyResult = await fulfillShopifyOrderWithTracking(
        order.shopId,
        order.platformOrderId,
        freshCredentials,
        {
          trackingNumber,
          trackingCompany,
          trackingUrl,
          notifyCustomer: input.notifyCustomer ?? true,
        },
      );
    } catch (error) {
      console.log(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: "warn",
          integration: "shopify",
          event: "fulfillment_writeback_failed",
          shopId: order.shopId,
          orderId: order.id,
          platformOrderId: order.platformOrderId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return {
        ok: false,
        message: error instanceof Error ? error.message : "Shopify fulfillment failed.",
      };
    }
  }

  try {
    await withUserContext(user, async (tx) => {
      const [current] = await tx
        .select({
          id: orders.id,
          businessId: orders.businessId,
          status: orders.status,
        })
        .from(orders)
        .where(eq(orders.id, orderId))
        .limit(1);
      if (!current) throw new OrderTransitionError("not_found", "Order not found.");

      const path = TRACKING_COMPLETION_PATHS[current.status as OrderStatus];
      if (!path) {
        throw new OrderTransitionError(
          "illegal",
          `Order must be approved, in print, shipped, delivered, fulfillment-only, or complete before adding final tracking.`,
        );
      }

      await tx.insert(printJobs).values({
        businessId: current.businessId,
        orderId,
        provider: input.provider,
        method: "manual",
        externalId: shopifyResult?.fulfillmentId ?? null,
        trackingNumber,
        trackingCompany: trackingCompany ?? null,
        trackingUrl: trackingUrl ?? null,
        shopifyFulfillmentId: shopifyResult?.fulfillmentId ?? null,
        shopifySyncedAt: shopifyResult ? new Date() : null,
        status: shopifyResult
          ? shopifyResult.closed
            ? "shopify_fulfilled_closed"
            : "shopify_fulfilled"
          : "tracking_added",
      });
      await tx.insert(activityLog).values({
        businessId: current.businessId,
        orderId,
        actorId: user.id,
        action: "order.tracking_added",
        metadata: {
          provider: input.provider,
          trackingCompany: trackingCompany ?? null,
          shopifyFulfillmentId: shopifyResult?.fulfillmentId ?? null,
          shopifyClosed: shopifyResult?.closed ?? null,
          via: "order_detail_tracking_card",
        },
      });

      let expectedFrom = current.status as OrderStatus;
      for (const to of path) {
        await runTransition(tx, user, {
          orderId,
          to,
          expectedFrom,
          metadata: {
            via: "tracking_added_complete",
            trackingNumber,
            shopifyFulfillmentId: shopifyResult?.fulfillmentId ?? null,
          },
        });
        expectedFrom = to;
      }
    });
  } catch (error) {
    if (error instanceof OrderTransitionError) {
      return { ok: false, message: error.message };
    }
    throw error;
  }

  revalidatePath(`/orders/${orderId}`);
  revalidatePath("/orders");
  revalidatePath("/board");
  revalidatePath("/dashboard");

  if (shopifyResult) {
    return {
      ok: true,
      message: shopifyResult.closeWarning
        ? "Tracking added and Shopify fulfillment created. Shopify did not close/archive the order; see warning."
        : "Tracking added, Shopify fulfillment created, and order completed.",
      closeWarning: shopifyResult.closeWarning,
    };
  }
  return { ok: true, message: "Tracking added and order completed." };
}
