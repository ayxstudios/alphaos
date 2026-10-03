import { parseDueDate } from "@/lib/time";
import { and, eq, sql } from "drizzle-orm";

import type { Tx } from "@/lib/db";
import { shops, orders, orderItems, customers, assets, activityLog } from "@/lib/db/schema";
import { parseFigureCount } from "@/lib/orders/manual-input";
import { runTransition, type OrderStatus } from "@/lib/orders/transitions";
import { shopStyleChoices } from "@/lib/designers/styles";
import { referenceUploadProblem } from "@/lib/uploads/verify";
import { withSizeOption } from "@/lib/orders/size-option";

/**
 * The core of "complete an imported awaiting_details order", shared by the VA
 * server action (`completeOrderDetails`, app/(app)/orders/new/actions.ts) and
 * the agent autopilot (lib/agent/autopilot.ts). The caller owns auth, the
 * transaction scope (user or system context), cache revalidation and error
 * reporting; everything that touches the order lives here, once.
 */

export type CompleteDetailsInput = {
  orderId: string;
  figureCount?: number | null;
  /** Where figureCount came from. Default "manual" (a VA typed it). */
  figureCountSource?: "manual" | "shop_rule";
  style?: string | null;
  /** Default: locked whenever a style is given (a VA picked it by hand). */
  styleLocked?: boolean;
  productTitle?: string | null;
  productType: "digital" | "physical";
  notes?: string;
  dueAt?: string;
  customerName?: string;
  customerEmail?: string;
  r2Keys?: string[];
  photoUrls?: string[];
  /** Print size / canvas, saved as a Size option on the item (undefined = leave options alone). */
  size?: string;
};

export type CompleteDetailsActor = { id: string; role: "admin" | "va" | "designer" | "system" };

export type CompleteDetailsOptions = {
  /** Refuse (ok:false) unless the order is in this status when locked. */
  expectedStatus?: OrderStatus;
  /** Transition metadata `via` for the awaiting_details edge. Default "manual_complete". */
  via?: string;
  /** Extra work in the same transaction after the order moved (e.g. an audit row). */
  afterApply?: (tx: Tx, applied: CompleteDetailsApplied) => Promise<void>;
};

export type CompleteDetailsApplied = {
  orderId: string;
  businessId: string;
  fromStatus: OrderStatus;
  toStatus: OrderStatus;
  photoCount: number;
};

export type CompleteDetailsResult =
  | { ok: true; orderNumber: string; orderId: string; fromStatus: OrderStatus; toStatus: OrderStatus }
  | { ok: false; message: string };

/** A typed email that is clearly not one ("not-an-email", "sara@") is refused, not stored. */
export function emailProblem(value: string | undefined): string | null {
  const email = value?.trim();
  if (!email) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? null : "That email does not look right. Check it, or leave it empty.";
}

export function splitName(name: string | undefined): [string | null, string | null] {
  const n = name?.trim();
  if (!n) return [null, null];
  const parts = n.split(/\s+/);
  return parts.length === 1 ? [parts[0], null] : [parts[0], parts.slice(1).join(" ")];
}

export function styleAllowed(inputStyle: string | null | undefined, styles: string[] | null): boolean {
  const style = inputStyle?.trim();
  if (!style) return true;
  return (styles ?? []).some((option) => option.trim().toLowerCase() === style.toLowerCase());
}

/**
 * Validate the input (no db), then run the completion inside `runInTx`.
 * Validation failures and business-rule refusals return ok:false; database
 * errors throw to the caller.
 */
export async function completeOrderDetailsCore(
  actor: CompleteDetailsActor,
  input: CompleteDetailsInput,
  runInTx: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>,
  opts: CompleteDetailsOptions = {},
): Promise<CompleteDetailsResult> {
  if (input.productType !== "digital" && input.productType !== "physical") {
    return { ok: false, message: "Choose a product type" };
  }
  const badEmail = emailProblem(input.customerEmail);
  if (badEmail) return { ok: false, message: badEmail };
  const figures = parseFigureCount(input.figureCount);
  if (!figures.ok) return { ok: false, message: figures.message };
  const figureCount = figures.value;
  const r2Keys = (input.r2Keys ?? []).filter(Boolean);
  const photoUrls = (input.photoUrls ?? []).map((u) => u.trim()).filter(Boolean);
  // activity_log.actor_id / assets.uploaded_by reference users; system is null.
  const actorUserId = actor.role === "system" ? null : actor.id;

  return runInTx(async (tx) => {
    const [order] = await tx
      .select({
        id: orders.id,
        businessId: orders.businessId,
        shopId: orders.shopId,
        status: orders.status,
        customerId: orders.customerId,
        platformOrderName: orders.platformOrderName,
      })
      .from(orders)
      .where(eq(orders.id, input.orderId))
      .for("update");
    if (!order) return { ok: false as const, message: "Order not found" };
    if (opts.expectedStatus && order.status !== opts.expectedStatus) {
      return { ok: false as const, message: `Order is ${order.status}, not ${opts.expectedStatus}` };
    }
    const businessId = order.businessId;
    const photoProblem = await referenceUploadProblem(r2Keys, `${businessId}/${order.id}/reference/`, photoUrls);
    if (photoProblem) return { ok: false as const, message: photoProblem };

    const [shop] = await tx
      .select({ styles: shops.styles })
      .from(shops)
      .where(eq(shops.id, order.shopId));
    if (!styleAllowed(input.style, await shopStyleChoices(tx, businessId, shop?.styles))) {
      return { ok: false as const, message: "Choose one of this shop's configured portrait styles." };
    }

    // Link or relink the customer whenever the VA supplies an email. Customer
    // uniqueness is per business, so this never merges across tenants.
    let customerId = order.customerId;
    const email = input.customerEmail?.trim().toLowerCase() || null;
    if (email) {
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
      .select({ id: orderItems.id, options: orderItems.options })
      .from(orderItems)
      .where(eq(orderItems.orderId, order.id))
      .for("update")
      .limit(1);
    const itemValues = {
      businessId,
      orderId: order.id,
      title: input.productTitle?.trim() || null,
      figureCount,
      figureCountSource: figureCount != null ? (input.figureCountSource ?? ("manual" as const)) : null,
      style: input.style?.trim() || null,
      // A style the VA picked by hand is a hand-set: the order page shows it
      // as chosen (not "Defaulted ... please confirm") and a re-resolve keeps it.
      styleLocked: input.styleLocked ?? !!input.style?.trim(),
      productType: input.productType,
      // Only touch options when the form carried a size, so an imported
      // order's other options are never lost.
      ...(input.size !== undefined ? { options: withSizeOption(existingItem?.options, input.size) } : {}),
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
        uploadedBy: actorUserId,
      })),
      ...photoUrls.map((url) => ({
        businessId,
        orderId: order.id,
        type: "reference" as const,
        storage: "cdn" as const,
        url,
        uploadedBy: actorUserId,
      })),
    ];
    if (assetRows.length) await tx.insert(assets).values(assetRows);

    const [assetCount] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(assets)
      .where(eq(assets.orderId, order.id));

    await tx
      .update(orders)
      .set({
        customerId,
        notes: input.notes?.trim() || null,
        ...(input.dueAt ? { dueAt: parseDueDate(input.dueAt) } : {}),
      })
      .where(eq(orders.id, order.id));

    // Enter or resume the pipeline via existing legal state-machine edges.
    const photoCount = Number(assetCount?.count ?? 0);
    const hasPhotos = photoCount > 0;
    let toStatus: OrderStatus = order.status;
    if (order.status === "awaiting_details") {
      const to = hasPhotos ? "ready_to_assign" : "awaiting_photos";
      await runTransition(tx, { id: actor.id, role: actor.role }, {
        orderId: order.id,
        to,
        expectedFrom: "awaiting_details",
        metadata: { via: opts.via ?? "manual_complete" },
      });
      toStatus = to;
    } else if (order.status === "awaiting_photos" && hasPhotos) {
      await runTransition(tx, { id: actor.id, role: actor.role }, {
        orderId: order.id,
        to: "ready_to_assign",
        expectedFrom: "awaiting_photos",
        metadata: { via: "manual_photo_upload" },
      });
      toStatus = "ready_to_assign";
    } else {
      await tx.insert(activityLog).values({
        businessId,
        orderId: order.id,
        actorId: actorUserId,
        action: "order.details_updated",
        fromState: order.status,
        toState: order.status,
        metadata: { photoCount, style: input.style ?? null },
      });
    }

    if (opts.afterApply) {
      await opts.afterApply(tx, { orderId: order.id, businessId, fromStatus: order.status, toStatus, photoCount });
    }

    return {
      ok: true as const,
      orderNumber: order.platformOrderName ?? "(no number)",
      orderId: order.id,
      fromStatus: order.status,
      toStatus,
    };
  });
}
