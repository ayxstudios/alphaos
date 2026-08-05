import { and, eq, sql } from "drizzle-orm";

import type { Tx } from "@/lib/db";
import { orders, assets, activityLog } from "@/lib/db/schema";

/**
 * Reconciliation of a VA-entered manual order with its later platform import.
 *
 * A manual order stores the human order number the VA typed in
 * `platform_order_name`, and a sentinel `platform_order_id = "manual:<number>"`
 * (Shopify's real key is the internal legacyResourceId, which a VA never has).
 * When the platform later imports the same order, we match on the human number
 * and PROMOTE the manual row in place — attaching the real platform id and
 * filling only gaps — rather than inserting a duplicate or overwriting the VA's
 * data. Preserve-not-overwrite.
 */

/** Lower/trim and drop a leading '#', so "#PC31972" and "pc31972" reconcile. */
export function normalizeOrderNumber(n: string): string {
  return n.trim().toLowerCase().replace(/^#/, "");
}

export async function reconcileManualOrder(
  tx: Tx,
  args: {
    shopId: string;
    businessId: string;
    realPlatformOrderId: string; // legacyResourceId / receipt_id
    orderNumber: string | null; // human number from the import
    customerId: string | null; // import's customer, to fill a gap
    photoUrls: string[]; // import's reference photos, to fill a gap
    rawImport?: unknown; // raw platform payload, to fill a gap (e.g. Etsy receipt)
  },
): Promise<{ reconciled: boolean; orderId?: string }> {
  if (!args.orderNumber) return { reconciled: false };
  const norm = normalizeOrderNumber(args.orderNumber);

  // A not-yet-linked manual order in this shop with a matching number.
  const [manual] = await tx
    .select({ id: orders.id, customerId: orders.customerId, rawImport: orders.rawImport })
    .from(orders)
    .where(
      and(
        eq(orders.shopId, args.shopId),
        eq(orders.source, "manual"),
        sql`${orders.platformOrderId} like 'manual:%'`,
        sql`lower(${orders.platformOrderName}) = ${norm}`,
      ),
    )
    .for("update")
    .limit(1);
  if (!manual) return { reconciled: false };

  // Promote: attach the real platform id; fill the customer only if the VA left
  // it blank. Never touch status, figure count, style, notes, or due date.
  await tx
    .update(orders)
    .set({
      platformOrderId: args.realPlatformOrderId,
      ...(manual.customerId == null && args.customerId ? { customerId: args.customerId } : {}),
      ...(args.rawImport && manual.rawImport == null ? { rawImport: args.rawImport } : {}),
      updatedAt: new Date(),
    })
    .where(eq(orders.id, manual.id));

  // Add the import's reference photos only if the VA attached none.
  if (args.photoUrls.length) {
    const [hasPhoto] = await tx
      .select({ id: assets.id })
      .from(assets)
      .where(and(eq(assets.orderId, manual.id), eq(assets.type, "reference")))
      .limit(1);
    if (!hasPhoto) {
      await tx.insert(assets).values(
        args.photoUrls.map((url) => ({
          businessId: args.businessId,
          orderId: manual.id,
          type: "reference" as const,
          storage: "cdn" as const,
          url,
        })),
      );
    }
  }

  await tx.insert(activityLog).values({
    businessId: args.businessId,
    orderId: manual.id,
    actorId: null, // platform-driven
    action: "order.reconciled",
    metadata: { realPlatformOrderId: args.realPlatformOrderId, orderNumber: args.orderNumber },
  });

  return { reconciled: true, orderId: manual.id };
}
