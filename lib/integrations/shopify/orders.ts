import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";

import { withSystemContext } from "@/lib/db";
import { getShopCredentials } from "@/lib/db/credentials";
import { shops, orders, orderItems, customers, assets, activityLog } from "@/lib/db/schema";
import type { NormalizedVariation } from "../figures";
import { ShopifyClient } from "./client";
import { resolveFigureCount } from "./figures";
import type {
  GqlOrder,
  GqlOrdersResponse,
  ShopifyCredentials,
  ShopifyIntegrationConfig,
} from "./types";

const PAGE = 50;
const STALE_LOCK_MS = 10 * 60 * 1000;
const FIRST_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_TURNAROUND_DAYS = 3;

export type SyncSummary = {
  imported: number;
  skipped: number;
  failed: number;
  skippedRun?: "already_running" | "not_connected";
  errors: { platformOrderId: string; error: string }[];
};

/** Everything importShopifyOrder needs about the destination shop. */
export type ShopContext = {
  id: string;
  businessId: string;
  slaConfig: Record<string, unknown> | null;
  config: ShopifyIntegrationConfig;
};

export type NormalizedLineItem = {
  sku: string | null;
  title: string | null;
  variantTitle: string | null;
  digital: boolean;
  quantity: number;
  options: NormalizedVariation[]; // for figure resolution
  photoUrls: string[]; // customer-uploaded reference photos (CDN URLs)
};

export type NormalizedOrder = {
  platformOrderId: string; // numeric legacy id (consistent across webhook + sync)
  createdAt: Date;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  lineItems: NormalizedLineItem[];
};

const ORDERS_QUERY = `
query($cursor: String, $q: String) {
  orders(first: ${PAGE}, after: $cursor, sortKey: CREATED_AT, query: $q) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      legacyResourceId
      createdAt
      email
      customer { firstName lastName email }
      lineItems(first: 50) {
        nodes {
          sku
          title
          variantTitle
          quantity
          requiresShipping
          variant { selectedOptions { name value } }
          customAttributes { key value }
        }
      }
    }
  }
}`;

/**
 * Pull orders for a shop and map them to orders + order_items. Same idempotency
 * and per-order-transaction / cursor semantics as the Etsy sync. Used for manual
 * "Sync now" and backfill; the webhook path shares importShopifyOrder.
 */
export async function syncShopOrders(shopId: string): Promise<SyncSummary> {
  const empty: SyncSummary = { imported: 0, skipped: 0, failed: 0, errors: [] };

  const claim = await withSystemContext(async (tx) => {
    await tx.execute(sql`select id from shops where id = ${shopId} for update`);
    const [shop] = await tx
      .select({
        id: shops.id,
        businessId: shops.businessId,
        integrationConfig: shops.integrationConfig,
        slaConfig: shops.slaConfig,
      })
      .from(shops)
      .where(eq(shops.id, shopId));
    if (!shop) throw new Error(`Shop not found: ${shopId}`);

    const cfg = (shop.integrationConfig ?? {}) as ShopifyIntegrationConfig;
    if (cfg.syncingSince && Date.now() - new Date(cfg.syncingSince).getTime() < STALE_LOCK_MS) {
      return { kind: "already_running" as const };
    }
    const creds = (await getShopCredentials(tx, shopId)) as ShopifyCredentials;
    if (!creds.accessToken || !creds.shopDomain) return { kind: "not_connected" as const };

    await tx
      .update(shops)
      .set({ integrationConfig: { ...cfg, syncingSince: new Date().toISOString() } })
      .where(eq(shops.id, shopId));

    return { kind: "ok" as const, shop, cfg, creds };
  });

  if (claim.kind === "already_running") return { ...empty, skippedRun: "already_running" };
  if (claim.kind === "not_connected") return { ...empty, skippedRun: "not_connected" };

  const { shop, cfg, creds } = claim;
  const ctx: ShopContext = {
    id: shop.id,
    businessId: shop.businessId,
    slaConfig: shop.slaConfig as Record<string, unknown> | null,
    config: cfg,
  };
  const client = new ShopifyClient(shopId, creds.shopDomain!, creds.accessToken!);
  const summary: SyncSummary = { imported: 0, skipped: 0, failed: 0, errors: [] };
  let maxCreated = cfg.syncCursor ?? "";

  try {
    const since = cfg.syncCursor ?? new Date(Date.now() - FIRST_WINDOW_MS).toISOString();
    const q = `created_at:>='${since}'`;
    let cursor: string | null = null;

    for (;;) {
      const data: GqlOrdersResponse = await client.graphql<GqlOrdersResponse>(ORDERS_QUERY, {
        cursor,
        q,
      });
      for (const node of data.orders.nodes) {
        const normalized = normalizeGraphqlOrder(node);
        try {
          const result = await importShopifyOrder({ shop: ctx, order: normalized, via: "sync" });
          if (result === "imported") summary.imported++;
          else summary.skipped++;
          if (node.createdAt > maxCreated) maxCreated = node.createdAt;
        } catch (err) {
          summary.failed++;
          summary.errors.push({ platformOrderId: normalized.platformOrderId, error: String(err) });
          logShopify(shopId, { level: "error", event: "order_import_failed", platformOrderId: normalized.platformOrderId, error: String(err) });
        }
      }
      if (!data.orders.pageInfo.hasNextPage) break;
      cursor = data.orders.pageInfo.endCursor;
    }

    await withSystemContext((tx) =>
      tx
        .update(shops)
        .set({ integrationConfig: { ...cfg, syncCursor: maxCreated || since, syncingSince: undefined } })
        .where(eq(shops.id, shopId)),
    );
    return summary;
  } catch (err) {
    await withSystemContext((tx) =>
      tx
        .update(shops)
        .set({ integrationConfig: { ...cfg, syncingSince: undefined } })
        .where(eq(shops.id, shopId)),
    );
    throw err;
  }
}

/**
 * Import one normalized order in its own transaction (atomic; idempotent).
 * Shared by the webhook and the sync. Lands in ready_to_assign if reference
 * photos were attached at import, otherwise awaiting_photos.
 */
export async function importShopifyOrder(args: {
  shop: ShopContext;
  order: NormalizedOrder;
  via: "webhook" | "sync";
}): Promise<"imported" | "skipped"> {
  const { shop, order, via } = args;
  const email = order.email?.trim().toLowerCase() || null;

  const items = order.lineItems.map((li) => {
    const fig = resolveFigureCount(li.options, shop.config);
    return { li, count: fig.count, source: fig.source, note: fig.note };
  });
  const anyPhotos = order.lineItems.some((li) => li.photoUrls.length > 0);
  const status = anyPhotos ? ("ready_to_assign" as const) : ("awaiting_photos" as const);
  const needsReview = !email || items.some((i) => i.source === "unresolved");
  const dueAt = computeDueAt(order.createdAt, shop.slaConfig);

  return withSystemContext(async (tx) => {
    let customerId: string | null = null;
    if (email) {
      await tx
        .insert(customers)
        .values({ businessId: shop.businessId, email, firstName: order.firstName, lastName: order.lastName })
        .onConflictDoNothing({ target: [customers.businessId, customers.email] });
      const [c] = await tx
        .select({ id: customers.id })
        .from(customers)
        .where(and(eq(customers.businessId, shop.businessId), eq(customers.email, email)));
      customerId = c?.id ?? null;
    }

    const inserted = await tx
      .insert(orders)
      .values({
        businessId: shop.businessId,
        shopId: shop.id,
        customerId,
        platformOrderId: order.platformOrderId,
        status,
        source: "shopify",
        placedAt: order.createdAt,
        dueAt,
        uploadToken: randomUUID(),
        needsReview,
      })
      .onConflictDoNothing({ target: [orders.shopId, orders.platformOrderId] })
      .returning({ id: orders.id });

    if (!inserted.length) return "skipped";
    const orderId = inserted[0].id;

    const itemRows = await tx
      .insert(orderItems)
      .values(
        items.map((i) => ({
          businessId: shop.businessId,
          orderId,
          sku: i.li.sku,
          variation: summarizeOptions(i.li),
          figureCount: i.count,
          figureCountSource: i.source,
          rawVariations: i.li.options,
          style: findStyle(i.li),
          productType: i.li.digital ? ("digital" as const) : ("physical" as const),
        })),
      )
      .returning({ id: orderItems.id });

    // Reference photos: store the CDN URL, do NOT re-upload to R2.
    const assetValues = items.flatMap((i, idx) =>
      i.li.photoUrls.map((url) => ({
        businessId: shop.businessId,
        orderId,
        orderItemId: itemRows[idx]?.id ?? null,
        type: "reference" as const,
        storage: "cdn" as const,
        url,
      })),
    );
    if (assetValues.length) await tx.insert(assets).values(assetValues);

    await tx.insert(activityLog).values({
      businessId: shop.businessId,
      orderId,
      actorId: null,
      action: "order.imported",
      fromState: null,
      toState: status,
      metadata: {
        source: "shopify",
        via,
        orderId: order.platformOrderId,
        itemCount: items.length,
        hasEmail: !!email,
        photoCount: assetValues.length,
        needsReview,
        figures: items.map((i) => ({ count: i.count, source: i.source, note: i.note })),
      },
    });

    return "imported";
  });
}

/* --- normalization ------------------------------------------------------ */
export function normalizeGraphqlOrder(o: GqlOrder): NormalizedOrder {
  return {
    platformOrderId: o.legacyResourceId,
    createdAt: new Date(o.createdAt),
    email: o.email ?? o.customer?.email ?? null,
    firstName: o.customer?.firstName ?? null,
    lastName: o.customer?.lastName ?? null,
    lineItems: o.lineItems.nodes.map((li) => {
      const attrs = li.customAttributes ?? [];
      const options: NormalizedVariation[] = [
        ...(li.variant?.selectedOptions ?? []).map((s) => ({ name: s.name, value: s.value })),
        ...attrs
          .filter((a) => a.value != null && !isUrl(a.value))
          .map((a) => ({ name: a.key, value: a.value as string })),
      ];
      if (li.variantTitle) options.push({ name: "Variant", value: li.variantTitle });
      return {
        sku: li.sku,
        title: li.title,
        variantTitle: li.variantTitle,
        digital: !li.requiresShipping,
        quantity: li.quantity,
        options,
        photoUrls: attrs.filter((a) => isUrl(a.value)).map((a) => a.value as string),
      };
    }),
  };
}

export function isUrl(v: string | null | undefined): boolean {
  return typeof v === "string" && /^https?:\/\//i.test(v.trim());
}

function summarizeOptions(li: NormalizedLineItem): string {
  const parts = li.options.map((o) => `${o.name}: ${o.value}`);
  return parts.length ? parts.join("; ") : (li.variantTitle ?? li.title ?? "");
}

function findStyle(li: NormalizedLineItem): string | null {
  const v = li.options.find((o) => o.name?.toLowerCase().includes("style"));
  return v?.value ?? null;
}

function computeDueAt(placedAt: Date, slaConfig: Record<string, unknown> | null): Date {
  const days =
    typeof slaConfig?.turnaroundDays === "number"
      ? (slaConfig.turnaroundDays as number)
      : DEFAULT_TURNAROUND_DAYS;
  return new Date(placedAt.getTime() + days * 24 * 60 * 60 * 1000);
}

function logShopify(shopId: string, extra: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), integration: "shopify", shopId, ...extra }));
}
