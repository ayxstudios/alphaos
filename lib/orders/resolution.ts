import { desc, eq } from "drizzle-orm";

import { withUserContext, type RequestUser } from "@/lib/db";
import { getShopCredentials } from "@/lib/db/credentials";
import { orders, orderItems, shops, activityLog } from "@/lib/db/schema";
import {
  resolveFigureCount,
  resolveStyle,
  type FigureConfig,
  type NormalizedVariation,
} from "@/lib/integrations/figures";
import {
  ShopifyClient,
  isShopifyConnected,
  fetchShopifyOrder,
  resolverInput,
  isAddOnLine,
  type NormalizedOrder,
  type NormalizedLineItem,
  type ShopifyCredentials,
} from "@/lib/integrations/shopify";

/**
 * Distinct option/property names seen in a shop's recent imports — the
 * click-to-add suggestions for the rules editor, so a VA doesn't have to type
 * (or guess) exact option names across 14 differently-configured shops.
 */
export async function getShopOptionNames(user: RequestUser, shopId: string): Promise<string[]> {
  return withUserContext(user, async (tx) => {
    const rows = await tx
      .select({ raw: orderItems.rawVariations })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .where(eq(orders.shopId, shopId))
      .orderBy(desc(orders.createdAt))
      .limit(500);
    const names = new Set<string>();
    for (const r of rows) {
      for (const v of (Array.isArray(r.raw) ? r.raw : []) as NormalizedVariation[]) {
        // Skip the synthetic "Variant" pair and photo-ish keys.
        if (v?.name && v.name !== "Variant") names.add(v.name);
      }
    }
    return [...names].sort((a, b) => a.localeCompare(b)).slice(0, 60);
  });
}

export type ReresolveSummary = {
  ordersProcessed: number;
  itemsResolved: number;
  stillUnresolved: number;
  addOnsRemoved: number;
  namesBackfilled: number;
  refetched: number;
};

const variationText = (li: NormalizedLineItem) =>
  [...li.selectedOptions, ...li.properties].map((o) => `${o.name}: ${o.value}`).join("; ");

/**
 * Re-run figure + style resolution against a shop's ALREADY-IMPORTED orders
 * using the current rules, so tuning rules heals existing orders instead of
 * leaving them unresolved forever.
 *
 * For a connected Shopify shop each order is re-fetched from the Admin API, which
 * also backfills the human order number, the product title, and structured
 * options that weren't captured at their original import (and drops add-on lines
 * like tips). For Etsy / disconnected shops it recomputes offline from the stored
 * raw_variations. Never touches order status or assignments; recomputes
 * needs_review. Per-order transactions keep API latency out of a long DB lock.
 */
export async function reresolveShop(user: RequestUser, shopId: string): Promise<ReresolveSummary> {
  const shopMeta = await withUserContext(user, async (tx) => {
    const [s] = await tx
      .select({ platform: shops.platform, integrationConfig: shops.integrationConfig })
      .from(shops)
      .where(eq(shops.id, shopId));
    return s;
  });
  if (!shopMeta) throw new Error("Shop not found");
  const cfg = (shopMeta.integrationConfig ?? {}) as FigureConfig;

  // A Shopify client for re-fetch, when the shop is connected.
  let client: ShopifyClient | null = null;
  if (shopMeta.platform === "shopify") {
    const creds = (await withUserContext(user, (tx) => getShopCredentials(tx, shopId))) as ShopifyCredentials;
    if (isShopifyConnected(creds)) client = new ShopifyClient(shopId, creds);
  }

  const orderList = await withUserContext(user, (tx) =>
    tx
      .select({
        id: orders.id,
        businessId: orders.businessId,
        platformOrderId: orders.platformOrderId,
        platformOrderName: orders.platformOrderName,
        customerId: orders.customerId,
      })
      .from(orders)
      .where(eq(orders.shopId, shopId)),
  );

  const summary: ReresolveSummary = {
    ordersProcessed: 0,
    itemsResolved: 0,
    stillUnresolved: 0,
    addOnsRemoved: 0,
    namesBackfilled: 0,
    refetched: 0,
  };

  for (const o of orderList) {
    summary.ordersProcessed++;

    // Re-fetch (API call OUTSIDE any transaction) when we have a Shopify client.
    let fresh: NormalizedOrder | null = null;
    if (client) {
      try {
        fresh = await fetchShopifyOrder(client, o.platformOrderId);
      } catch {
        fresh = null; // fall back to offline recompute
      }
    }

    await withUserContext(user, async (tx) => {
      if (fresh) {
        summary.refetched++;
        if (fresh.orderName && fresh.orderName !== o.platformOrderName) {
          await tx.update(orders).set({ platformOrderName: fresh.orderName }).where(eq(orders.id, o.id));
          summary.namesBackfilled++;
        }
        const realLines = fresh.lineItems.filter((li) => !isAddOnLine(li));
        summary.addOnsRemoved += fresh.lineItems.length - realLines.length;

        // Replace items from fresh data (title/options weren't captured before).
        await tx.delete(orderItems).where(eq(orderItems.orderId, o.id));
        for (const li of realLines) {
          const input = resolverInput(li);
          const fig = resolveFigureCount(input, cfg);
          const st = resolveStyle(input, cfg);
          if (fig.count != null) summary.itemsResolved++;
          else summary.stillUnresolved++;
          await tx.insert(orderItems).values({
            businessId: o.businessId,
            orderId: o.id,
            sku: li.sku,
            title: li.title,
            variation: variationText(li),
            options: li.selectedOptions,
            figureCount: fig.count,
            figureCountSource: fig.source,
            rawVariations: input,
            style: st.style,
            productType: li.digital ? ("digital" as const) : ("physical" as const),
          });
        }
      } else {
        // Offline recompute from the stored raw_variations.
        const its = await tx.select().from(orderItems).where(eq(orderItems.orderId, o.id));
        for (const it of its) {
          const raw = (Array.isArray(it.rawVariations) ? it.rawVariations : []) as NormalizedVariation[];
          // An add-on row that slipped in before the exclusion existed.
          if (!it.sku && raw.length === 0) {
            await tx.delete(orderItems).where(eq(orderItems.id, it.id));
            summary.addOnsRemoved++;
            continue;
          }
          const fig = resolveFigureCount(raw, cfg);
          const st = resolveStyle(raw, cfg);
          if (fig.count != null) summary.itemsResolved++;
          else summary.stillUnresolved++;
          await tx
            .update(orderItems)
            .set({ figureCount: fig.count, figureCountSource: fig.source, style: st.style })
            .where(eq(orderItems.id, it.id));
        }
      }

      // Recompute needs_review from the resulting items (+ missing customer).
      const remaining = await tx
        .select({ figureCount: orderItems.figureCount })
        .from(orderItems)
        .where(eq(orderItems.orderId, o.id));
      const needsReview = o.customerId == null || remaining.some((r) => r.figureCount == null);
      await tx.update(orders).set({ needsReview }).where(eq(orders.id, o.id));

      await tx.insert(activityLog).values({
        businessId: o.businessId,
        orderId: o.id,
        actorId: user.id,
        action: "order.reresolved",
        metadata: { refetched: !!fresh, needsReview },
      });
    });
  }

  return summary;
}
