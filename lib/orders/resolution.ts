import { and, desc, eq } from "drizzle-orm";

import { withUserContext, type RequestUser } from "@/lib/db";
import { getShopCredentials } from "@/lib/db/credentials";
import { orders, orderItems, shops, activityLog, assets, assignments } from "@/lib/db/schema";
import { runAutoAssign } from "./assign";
import {
  resolveFigureCount,
  type FigureConfig,
  type NormalizedVariation,
} from "@/lib/integrations/figures";
import { listBusinessStyles, matchStyle, type BusinessStyle } from "@/lib/designers/styles";
import { classifyOrder, type ClassifyConfig, type OrderClass } from "@/lib/integrations/classify";
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

/** Distinct SKUs + product titles from recent imports — chips for the
 *  non-portrait classifier editor. */
export async function getShopSkusAndTitles(
  user: RequestUser,
  shopId: string,
): Promise<{ skus: string[]; titles: string[] }> {
  return withUserContext(user, async (tx) => {
    const rows = await tx
      .select({ sku: orderItems.sku, title: orderItems.title })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .where(eq(orders.shopId, shopId))
      .orderBy(desc(orders.createdAt))
      .limit(500);
    const skus = new Set<string>();
    const titles = new Set<string>();
    for (const r of rows) {
      if (r.sku) skus.add(r.sku);
      if (r.title) titles.add(r.title);
    }
    const sort = (s: Set<string>) => [...s].sort((a, b) => a.localeCompare(b)).slice(0, 60);
    return { skus: sort(skus), titles: sort(titles) };
  });
}

export type ReresolveSummary = {
  ordersProcessed: number;
  itemsResolved: number;
  stillUnresolved: number;
  addOnsRemoved: number;
  namesBackfilled: number;
  refetched: number;
  reclassified: number; // moved to a different portrait/non-portrait lifecycle
  reclassifySkipped: number; // would move, but a designer already touched it
};

/** Coarse lifecycle bucket, for deciding whether re-classification may move an order. */
type Bucket = "portrait" | "fulfillment_only" | "triage" | "designer";
function statusBucket(status: string): Bucket {
  if (status === "awaiting_photos" || status === "ready_to_assign") return "portrait";
  if (status === "fulfillment_only") return "fulfillment_only";
  if (status === "triage") return "triage";
  // in_design and beyond (incl. on_hold / cancelled) — a designer may have touched it.
  return "designer";
}

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
 * raw_variations.
 *
 * It ALSO re-classifies orders under the current non-portrait rules — but only
 * while they're still pre-design (awaiting_photos / ready_to_assign / triage /
 * fulfillment_only). If a designer has already touched an order (in_design or
 * beyond), it is never moved; the skip is logged (order.reclassify_skipped).
 * Recomputes needs_review. Per-order transactions keep API latency out of a long
 * DB lock.
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
  const cfg = (shopMeta.integrationConfig ?? {}) as FigureConfig & ClassifyConfig;

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
        status: orders.status,
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
    reclassified: 0,
    reclassifySkipped: 0,
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
      // Lines used for (re)classification, and the draft-order signal.
      let classLines: { sku: string | null; title: string | null }[] = [];
      const sourceName = fresh?.sourceName ?? null;
      // Portrait styles are business-level; resolve each item's style by title.
      const businessStyles: BusinessStyle[] = await listBusinessStyles(tx, o.businessId);

      if (fresh) {
        summary.refetched++;
        if (fresh.orderName && fresh.orderName !== o.platformOrderName) {
          await tx.update(orders).set({ platformOrderName: fresh.orderName }).where(eq(orders.id, o.id));
          summary.namesBackfilled++;
        }
        const realLines = fresh.lineItems.filter((li) => !isAddOnLine(li));
        summary.addOnsRemoved += fresh.lineItems.length - realLines.length;
        classLines = realLines.map((li) => ({ sku: li.sku, title: li.title }));

        // Replace items from fresh data (title/options weren't captured before).
        await tx.delete(orderItems).where(eq(orderItems.orderId, o.id));
        for (const li of realLines) {
          const input = resolverInput(li);
          const fig = resolveFigureCount(input, cfg);
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
            style: matchStyle(li.title, businessStyles),
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
          if (fig.count != null) summary.itemsResolved++;
          else summary.stillUnresolved++;
          classLines.push({ sku: it.sku, title: it.title });
          await tx
            .update(orderItems)
            .set({ figureCount: fig.count, figureCountSource: fig.source, style: matchStyle(it.title, businessStyles) })
            .where(eq(orderItems.id, it.id));
        }
      }

      // --- Re-classification -------------------------------------------------
      // Compute the class the order WOULD get under current rules. Offline we
      // can't see the draft-order source, so triage is only reachable via a
      // Shopify re-fetch — an already-triaged order left offline stays put.
      const intended: OrderClass = classifyOrder({ sourceName, lines: classLines, config: cfg });
      const current = statusBucket(o.status);
      let newStatus = o.status;
      let reclassified = false;

      if (current === "designer") {
        // A designer has touched it — never move. Log only if it WOULD have moved.
        if (intended !== "portrait") {
          summary.reclassifySkipped++;
          await tx.insert(activityLog).values({
            businessId: o.businessId,
            orderId: o.id,
            actorId: user.id,
            action: "order.reclassify_skipped",
            fromState: o.status,
            metadata: { intended, reason: "designer already touched this order" },
          });
        }
      } else if (current !== intended) {
        // Eligible (pre-design) and the bucket changed — move it.
        if (intended === "portrait") {
          const [photo] = await tx
            .select({ id: assets.id })
            .from(assets)
            .where(and(eq(assets.orderId, o.id), eq(assets.type, "reference")))
            .limit(1);
          newStatus = photo ? "ready_to_assign" : "awaiting_photos";
        } else if (intended === "fulfillment_only") {
          newStatus = "fulfillment_only";
        } else {
          newStatus = "triage";
        }
        reclassified = newStatus !== o.status;
        if (reclassified) {
          summary.reclassified++;
          await tx.update(orders).set({ status: newStatus }).where(eq(orders.id, o.id));
          await tx.insert(activityLog).values({
            businessId: o.businessId,
            orderId: o.id,
            actorId: user.id,
            action: "order.reclassified",
            fromState: o.status,
            toState: newStatus,
            metadata: { intended },
          });
        }
      }

      // Recompute needs_review. Non-portrait never flags on unresolved figures.
      const remaining = await tx
        .select({ figureCount: orderItems.figureCount })
        .from(orderItems)
        .where(eq(orderItems.orderId, o.id));
      const needsReview =
        o.customerId == null || (intended === "portrait" && remaining.some((r) => r.figureCount == null));
      await tx.update(orders).set({ needsReview }).where(eq(orders.id, o.id));

      // Heal routing too: an order that is now assignable (ready_to_assign, no
      // longer needs review) but has no active designer gets auto-assigned, so
      // fixing rules pushes healed orders straight to a designer instead of
      // leaving them stranded in the VA review queue. An order that already has an
      // active assignee is never disturbed.
      let assignedTo: string | null = null;
      if (newStatus === "ready_to_assign" && !needsReview) {
        const [active] = await tx
          .select({ orderId: assignments.orderId })
          .from(assignments)
          .where(and(eq(assignments.orderId, o.id), eq(assignments.active, true)))
          .limit(1);
        if (!active) {
          assignedTo = (
            await runAutoAssign(tx, { orderId: o.id, businessId: o.businessId, assignedBy: user.id })
          ).assigned;
        }
      }

      await tx.insert(activityLog).values({
        businessId: o.businessId,
        orderId: o.id,
        actorId: user.id,
        action: "order.reresolved",
        metadata: { refetched: !!fresh, needsReview, intended, reclassified, assignedTo },
      });
    });
  }

  return summary;
}
