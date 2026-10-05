import { and, eq, sql } from "drizzle-orm";

import type { Tx } from "@/lib/db";
import { orders, orderItems, assets, activityLog, type ProductOption } from "@/lib/db/schema";

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
    /** Import-built item rows (buyer-chosen options etc.), to fill a gap only. */
    importItems?: {
      sku: string | null;
      title: string | null;
      options: ProductOption[];
      rawVariations: unknown;
      productType: "physical" | "digital";
    }[];
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

  // Item options from the import, preserve-not-overwrite: a manual order with
  // no items at all gets the import's rows; one whose first item has no options
  // gets just the options/raw variations filled in; a transaction with no row
  // at all gets one added (2026-10-06: a two-pet receipt showed only Bubba,
  // Tigger's line was never written). VA-set fields never change.
  if (args.importItems?.length) {
    await mergeImportItems(tx, { businessId: args.businessId, orderId: manual.id, importItems: args.importItems });
  }

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

/** Import-built item row shape shared by the Etsy/Shopify connectors. */
export type ImportItem = {
  sku: string | null;
  title: string | null;
  options: ProductOption[];
  rawVariations: unknown;
  productType: "physical" | "digital";
};

const optionsKey = (options: ProductOption[] | null | undefined) =>
  JSON.stringify((options ?? []).map((o) => [o.name, o.value]));

/**
 * Merge import-built item rows into an order, preserve-not-overwrite:
 * - no rows at all -> insert every import item;
 * - a row whose options already match an import item claims it (nothing changes);
 * - a row with no options consumes one unclaimed item and gets its options filled;
 * - leftover import items get rows added ONLY while the order has fewer rows
 *   than the receipt has transactions (2026-10-06: a two-pet Etsy receipt had
 *   one row, so Tigger's line never showed), so a VA-reshaped item list is
 *   never duplicated.
 */
export async function mergeImportItems(
  tx: Tx,
  args: { businessId: string; orderId: string; importItems: ImportItem[] },
): Promise<{ inserted: number; filled: number }> {
  const existing = await tx
    .select({ id: orderItems.id, options: orderItems.options })
    .from(orderItems)
    .where(eq(orderItems.orderId, args.orderId))
    .for("update");

  const toRow = (item: ImportItem) => ({
    businessId: args.businessId,
    orderId: args.orderId,
    sku: item.sku,
    title: item.title,
    options: item.options.length ? item.options : null,
    rawVariations: item.rawVariations,
    productType: item.productType,
  });

  if (!existing.length) {
    await tx.insert(orderItems).values(args.importItems.map(toRow));
    return { inserted: args.importItems.length, filled: 0 };
  }

  const unclaimed = [...args.importItems];
  for (const row of existing) {
    if (!row.options?.length) continue;
    const i = unclaimed.findIndex((item) => optionsKey(item.options) === optionsKey(row.options));
    if (i >= 0) unclaimed.splice(i, 1);
  }
  let filled = 0;
  for (const row of existing) {
    if (row.options?.length) continue;
    const item = unclaimed.shift();
    if (!item) break;
    if (item.options.length) {
      await tx
        .update(orderItems)
        .set({ options: item.options, rawVariations: item.rawVariations })
        .where(eq(orderItems.id, row.id));
      filled++;
    }
  }
  const room = Math.max(0, args.importItems.length - existing.length);
  const toInsert = unclaimed.slice(0, room);
  if (toInsert.length) await tx.insert(orderItems).values(toInsert.map(toRow));
  return { inserted: toInsert.length, filled };
}
