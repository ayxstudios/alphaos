"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { and, eq, sql } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { withUserContext, type RequestUser } from "@/lib/db";
import { shops, orders, orderItems, customers, assets, activityLog } from "@/lib/db/schema";
import { runAutoAssign } from "@/lib/orders/assign";
import { runTransition } from "@/lib/orders/transitions";
import { normalizeOrderNumber } from "@/lib/orders/reconcile";
import {
  assetKey,
  extFor,
  presignUpload,
  isR2Configured,
  MAX_UPLOAD_BYTES,
  ALLOWED_IMAGE_TYPES,
} from "@/lib/storage/r2";

export type NewOrderInput = {
  orderId: string; // client-minted (also the R2 key namespace)
  shopId: string;
  orderNumber?: string;
  customerName?: string;
  customerEmail?: string;
  figureCount?: number | null;
  style?: string | null;
  productTitle?: string | null;
  productType: "digital" | "physical";
  notes?: string;
  dueAt?: string; // ISO (date)
  r2Keys?: string[];
  photoUrls?: string[];
};

export type NewOrderResult =
  | { ok: true; orderNumber: string; orderId: string }
  | { ok: false; message: string };

async function requireVa(): Promise<RequestUser | { error: string }> {
  const session = await auth();
  const role = session?.user?.role;
  if (!session?.user) return { error: "Not signed in" };
  if (role !== "admin" && role !== "va") return { error: "Manual entry is VA/admin only" };
  return { id: session.user.id, role };
}

export type PresignResult =
  | { ok: true; uploads: { key: string; uploadUrl: string }[] }
  | { ok: false; message: string };

/**
 * Issue presigned PUT URLs for reference-photo uploads, so file bytes go direct
 * from the browser to R2 and never touch our server. VA/admin only; the caller
 * must be able to see the shop (RLS derives businessId). Each file is validated
 * server-side BEFORE a URL is issued: image content type + 25 MB cap.
 */
export async function presignReferenceUploads(input: {
  shopId: string;
  orderId: string;
  files: { filename: string; contentType: string; size: number }[];
}): Promise<PresignResult> {
  const authed = await requireVa();
  if ("error" in authed) return { ok: false, message: authed.error };
  if (!isR2Configured()) return { ok: false, message: "File storage is not configured" };
  if (!input.shopId || !input.orderId || !Array.isArray(input.files) || input.files.length === 0) {
    return { ok: false, message: "Nothing to upload" };
  }
  if (input.files.length > 20) return { ok: false, message: "Too many files (max 20)" };

  const [shop] = await withUserContext(authed, (tx) =>
    tx.select({ businessId: shops.businessId }).from(shops).where(eq(shops.id, input.shopId)),
  );
  if (!shop) return { ok: false, message: "Shop not found" };

  try {
    const uploads = await Promise.all(
      input.files.map(async (f) => {
        if (!ALLOWED_IMAGE_TYPES.test(f.contentType)) {
          throw new Error(`${f.filename}: not an image`);
        }
        if (typeof f.size !== "number" || f.size <= 0 || f.size > MAX_UPLOAD_BYTES) {
          throw new Error(`${f.filename}: over 25 MB`);
        }
        const key = assetKey(shop.businessId, input.orderId, "reference", extFor(f.filename, f.contentType));
        return { key, uploadUrl: await presignUpload({ key, contentType: f.contentType }) };
      }),
    );
    return { ok: true, uploads };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Could not prepare upload" };
  }
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
  if ("error" in authed) return { ok: false, message: authed.error };
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
        title: input.productTitle?.trim() || null,
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

/**
 * Complete an imported `awaiting_details` order (the Etsy Case-1 flow): a VA fills
 * figure count / style / product / notes / photos on the same manual form, and it
 * enters the pipeline (ready_to_assign + auto-assign if photos, else
 * awaiting_photos). The order header (number, customer, date) is not touched.
 */
export async function completeOrderDetails(input: {
  orderId: string;
  figureCount?: number | null;
  style?: string | null;
  productTitle?: string | null;
  productType: "digital" | "physical";
  notes?: string;
  dueAt?: string;
  customerName?: string;
  customerEmail?: string;
  r2Keys?: string[];
  photoUrls?: string[];
}): Promise<NewOrderResult> {
  const authed = await requireVa();
  if ("error" in authed) return { ok: false, message: authed.error };
  const user = authed;
  if (input.productType !== "digital" && input.productType !== "physical") {
    return { ok: false, message: "Choose a product type" };
  }
  const figureCount =
    typeof input.figureCount === "number" && input.figureCount > 0 ? Math.floor(input.figureCount) : null;
  const r2Keys = (input.r2Keys ?? []).filter(Boolean);
  const photoUrls = (input.photoUrls ?? []).map((u) => u.trim()).filter(Boolean);

  try {
    return await withUserContext(user, async (tx) => {
      const [order] = await tx
        .select({
          id: orders.id,
          businessId: orders.businessId,
          status: orders.status,
          customerId: orders.customerId,
          platformOrderName: orders.platformOrderName,
        })
        .from(orders)
        .where(eq(orders.id, input.orderId))
        .for("update");
      if (!order) return { ok: false as const, message: "Order not found" };
      if (order.status !== "awaiting_details") {
        return { ok: false as const, message: "This order is no longer awaiting details." };
      }
      const businessId = order.businessId;

      // Link a customer if the VA supplied an email and none is set.
      let customerId = order.customerId;
      const email = input.customerEmail?.trim().toLowerCase() || null;
      if (!customerId && email) {
        const [firstName, lastName] = splitName(input.customerName);
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

      const [existingItem] = await tx
        .select({ id: orderItems.id })
        .from(orderItems)
        .where(eq(orderItems.orderId, order.id))
        .for("update")
        .limit(1);
      const itemValues = {
        businessId,
        orderId: order.id,
        title: input.productTitle?.trim() || null,
        figureCount,
        figureCountSource: figureCount != null ? ("manual" as const) : null,
        style: input.style?.trim() || null,
        productType: input.productType,
      };
      if (existingItem) {
        await tx.update(orderItems).set(itemValues).where(eq(orderItems.id, existingItem.id));
      } else {
        await tx.insert(orderItems).values(itemValues);
      }

      const assetRows = [
        ...r2Keys.map((r2Key) => ({
          businessId,
          orderId: order.id,
          type: "reference" as const,
          storage: "r2" as const,
          r2Key,
          uploadedBy: user.id,
        })),
        ...photoUrls.map((url) => ({
          businessId,
          orderId: order.id,
          type: "reference" as const,
          storage: "cdn" as const,
          url,
          uploadedBy: user.id,
        })),
      ];
      if (assetRows.length) await tx.insert(assets).values(assetRows);

      await tx
        .update(orders)
        .set({
          customerId,
          notes: input.notes?.trim() || null,
          ...(input.dueAt ? { dueAt: new Date(input.dueAt) } : {}),
        })
        .where(eq(orders.id, order.id));

      // Enter the pipeline via the state machine (auto-assigns on ready_to_assign).
      const to = assetRows.length > 0 ? "ready_to_assign" : "awaiting_photos";
      await runTransition(tx, { id: user.id, role: user.role }, {
        orderId: order.id,
        to,
        expectedFrom: "awaiting_details",
        metadata: { via: "manual_complete" },
      });

      revalidatePath("/queue");
      revalidatePath("/board");
      revalidatePath(`/orders/${order.id}`);
      return { ok: true as const, orderNumber: order.platformOrderName ?? "(no number)", orderId: order.id };
    });
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Could not complete order" };
  }
}

export type OrderLookup =
  | { found: false }
  | { found: true; orderId: string; status: string; platformOrderName: string | null };

/**
 * Case-3 duplicate guard: as a VA types an order number in the New-order form,
 * look it up in the shop (normalised for whitespace / leading #) so we can point
 * them at the existing order instead of letting them create a duplicate.
 */
export async function lookupOrderByNumber(input: {
  shopId: string;
  orderNumber: string;
}): Promise<OrderLookup> {
  const authed = await requireVa();
  if ("error" in authed) return { found: false };
  const num = normalizeOrderNumber(input.orderNumber ?? "");
  if (!input.shopId || !num) return { found: false };
  const [row] = await withUserContext(authed, (tx) =>
    tx
      .select({ id: orders.id, status: orders.status, platformOrderName: orders.platformOrderName })
      .from(orders)
      .where(and(eq(orders.shopId, input.shopId), sql`lower(${orders.platformOrderName}) = ${num}`))
      .limit(1),
  );
  return row
    ? { found: true, orderId: row.id, status: row.status, platformOrderName: row.platformOrderName }
    : { found: false };
}
