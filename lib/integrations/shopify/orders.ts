import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";

import { withSystemContext } from "@/lib/db";
import { getShopCredentials } from "@/lib/db/credentials";
import { shops, orders, orderItems, customers, assets, activityLog } from "@/lib/db/schema";
import { queuePhotoRequest, flushQueued } from "@/lib/email/dispatch";
import type { NormalizedVariation } from "../figures";
import { ShopifyClient } from "./client";
import { isShopifyConnected } from "./auth";
import { resolveFigureCount, resolveStyle } from "./figures";
import { classifyOrder, photoRequestEnabled } from "../classify";
import { reconcileManualOrder } from "@/lib/orders/reconcile";
import { runAutoAssign } from "@/lib/orders/assign";
import type {
  GqlOrder,
  GqlOrdersResponse,
  ShopifyCredentials,
  ShopifyIntegrationConfig,
} from "./types";

const PAGE = 50;
const STALE_LOCK_MS = 10 * 60 * 1000;
// First sync pulls the widest range read_orders exposes without protected-data
// approval (last 60 days), so a fresh shop backfills everything reachable.
const FIRST_WINDOW_MS = 60 * 24 * 60 * 60 * 1000;
const DEFAULT_TURNAROUND_DAYS = 3;

export type SyncSummary = {
  imported: number;
  skipped: number;
  failed: number;
  skippedRun?: "already_running" | "not_connected";
  errors: { platformOrderId: string; error: string }[];
  reconciled?: number; // manual orders matched + promoted in place
  // Context so the UI/logs show the whole picture, not just this run's delta.
  total?: number; // total orders stored for the shop after this run
  windowStart?: string; // ISO — start of the range this run scanned
  windowDays?: number; // days from windowStart to now
};

/** Everything importShopifyOrder needs about the destination shop. */
export type ShopContext = {
  id: string;
  businessId: string;
  slaConfig: Record<string, unknown> | null;
  config: ShopifyIntegrationConfig;
  /**
   * Suppress ALL automated customer email for this import. Set on historical
   * backfills so re-scanning old orders never messages a customer. The webhook
   * and normal "Sync now" leave this false.
   */
  suppressCustomerEmail?: boolean;
};

export type NormalizedLineItem = {
  sku: string | null;
  title: string | null; // product title (what the designer is making)
  variantTitle: string | null;
  digital: boolean;
  quantity: number;
  hasVariant: boolean; // false + no sku => an add-on line (tip/fee), not a product
  selectedOptions: NormalizedVariation[]; // structured variant options (display + resolution)
  properties: NormalizedVariation[]; // line-item custom attributes, non-url (pet name, background…)
  photoUrls: string[]; // customer-uploaded reference photos (CDN URLs)
};

export type NormalizedOrder = {
  platformOrderId: string; // numeric legacy id (consistent across webhook + sync)
  orderName: string | null; // human order number (Shopify `name`, e.g. "PC31972")
  sourceName: string | null; // order attribution; "shopify_draft_order" => triage
  createdAt: Date;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  lineItems: NormalizedLineItem[];
};

/**
 * The full variation set the resolver runs against: variant selectedOptions +
 * line-item properties + the variant title (as a synthetic option). Stored as
 * raw_variations so a re-resolve reproduces the exact resolution.
 */
export function resolverInput(li: NormalizedLineItem): NormalizedVariation[] {
  return [
    ...li.selectedOptions,
    ...li.properties,
    ...(li.variantTitle ? [{ name: "Variant", value: li.variantTitle }] : []),
  ];
}

/** An add-on line (Shopify tip / fee): no variant and no sku. Never a portrait. */
export function isAddOnLine(li: NormalizedLineItem): boolean {
  return !li.hasVariant && !li.sku;
}

const ORDERS_QUERY = `
query($cursor: String, $q: String) {
  orders(first: ${PAGE}, after: $cursor, sortKey: CREATED_AT, query: $q) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      name
      sourceName
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
 *
 * `suppressCustomerEmail` (backfills) blocks every automated customer email: no
 * photo-request is queued at import, and the post-run flush is skipped.
 */
export async function syncShopOrders(
  shopId: string,
  opts: { suppressCustomerEmail?: boolean } = {},
): Promise<SyncSummary> {
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
    if (!isShopifyConnected(creds)) return { kind: "not_connected" as const };

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
    suppressCustomerEmail: !!opts.suppressCustomerEmail,
  };
  const client = new ShopifyClient(shopId, creds);
  const summary: SyncSummary = { imported: 0, skipped: 0, failed: 0, errors: [] };
  let maxCreated = cfg.syncCursor ?? "";

  try {
    const since = cfg.syncCursor ?? new Date(Date.now() - FIRST_WINDOW_MS).toISOString();
    const windowDays = Math.max(1, Math.round((Date.now() - new Date(since).getTime()) / 86_400_000));
    const q = `created_at:>='${since}'`;
    let cursor: string | null = null;

    // Log the exact range this run will cover, so the logs show what was scanned.
    logShopify(shopId, {
      event: "sync_start",
      priorCursor: cfg.syncCursor ?? null,
      windowStart: since,
      windowDays,
      firstSync: !cfg.syncCursor,
    });

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
          else if (result === "reconciled") summary.reconciled = (summary.reconciled ?? 0) + 1;
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

    const newCursor = maxCreated || since;
    const lastSyncAt = new Date().toISOString();
    await withSystemContext((tx) =>
      tx
        .update(shops)
        .set({ integrationConfig: { ...cfg, syncCursor: newCursor, syncingSince: undefined, lastSyncAt } })
        .where(eq(shops.id, shopId)),
    );

    // Total stored for the shop, so the caller can report "N total", not just delta.
    const [totals] = await withSystemContext((tx) =>
      tx.select({ n: sql<number>`count(*)::int` }).from(orders).where(eq(orders.shopId, shopId)),
    );
    summary.total = Number(totals?.n ?? 0);
    summary.windowStart = since;
    summary.windowDays = windowDays;

    logShopify(shopId, {
      event: "sync_complete",
      imported: summary.imported,
      skipped: summary.skipped,
      failed: summary.failed,
      total: summary.total,
      windowStart: since,
      windowDays,
      newCursor,
      lastSyncAt,
    });

    // Best-effort: auto-send the queued photo-request emails for this business.
    // Skipped entirely on a backfill so no historical order gets emailed.
    if (summary.imported > 0 && !opts.suppressCustomerEmail) {
      await flushQueued(shop.businessId).catch((e) =>
        logShopify(shopId, { level: "error", event: "photo_request_flush_failed", error: String(e) }),
      );
    }
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
}): Promise<"imported" | "skipped" | "reconciled"> {
  const { shop, order, via } = args;
  const email = order.email?.trim().toLowerCase() || null;

  // Exclude add-on lines (tips/fees: no variant, no sku) from the portrait items;
  // they'd otherwise import as junk order_items and keep the order unresolved.
  const realLines = order.lineItems.filter((li) => !isAddOnLine(li));
  const skippedAddOns = order.lineItems
    .filter((li) => isAddOnLine(li))
    .map((li) => ({ title: li.title, sku: li.sku, reason: "no variant and no sku" }));

  const items = realLines.map((li) => {
    const input = resolverInput(li);
    const fig = resolveFigureCount(input, shop.config);
    const style = resolveStyle(input, shop.config);
    return { li, input, count: fig.count, source: fig.source, note: fig.note, style: style.style };
  });
  const anyPhotos = order.lineItems.some((li) => li.photoUrls.length > 0);

  // Classify: a Shopify draft order -> triage; all-non-portrait -> fulfillment_only;
  // otherwise portrait (ready_to_assign if photos are attached, else awaiting_photos).
  const klass = classifyOrder({
    sourceName: order.sourceName,
    lines: realLines.map((li) => ({ sku: li.sku, title: li.title })),
    config: shop.config,
  });
  const status =
    klass === "triage"
      ? ("triage" as const)
      : klass === "fulfillment_only"
        ? ("fulfillment_only" as const)
        : anyPhotos
          ? ("ready_to_assign" as const)
          : ("awaiting_photos" as const);

  // Figure count only matters for portrait work; non-portrait never blocks review
  // on an unresolved count (it never pays a designer).
  const needsReview = !email || (klass === "portrait" && items.some((i) => i.source === "unresolved"));
  const dueAt = computeDueAt(order.createdAt, shop.slaConfig);
  const uploadToken = randomUUID();

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

    // Reconcile with a VA-entered manual order (matched on the human order
    // number) BEFORE inserting — promote it in place instead of duplicating.
    const rec = await reconcileManualOrder(tx, {
      shopId: shop.id,
      businessId: shop.businessId,
      realPlatformOrderId: order.platformOrderId,
      orderNumber: order.orderName,
      customerId,
      photoUrls: order.lineItems.flatMap((li) => li.photoUrls),
    });
    if (rec.reconciled) return "reconciled";

    const inserted = await tx
      .insert(orders)
      .values({
        businessId: shop.businessId,
        shopId: shop.id,
        customerId,
        platformOrderId: order.platformOrderId,
        platformOrderName: order.orderName ?? order.platformOrderId,
        status,
        source: "shopify",
        placedAt: order.createdAt,
        dueAt,
        uploadToken,
        needsReview,
      })
      .onConflictDoNothing({ target: [orders.shopId, orders.platformOrderId] })
      .returning({ id: orders.id });

    if (!inserted.length) return "skipped";
    const orderId = inserted[0].id;

    const itemRows = items.length
      ? await tx
          .insert(orderItems)
          .values(
            items.map((i) => ({
              businessId: shop.businessId,
              orderId,
              sku: i.li.sku,
              title: i.li.title,
              variation: summarizeOptions(i.li),
              options: i.li.selectedOptions,
              figureCount: i.count,
              figureCountSource: i.source,
              rawVariations: i.input,
              style: i.style,
              productType: i.li.digital ? ("digital" as const) : ("physical" as const),
            })),
          )
          .returning({ id: orderItems.id })
      : [];

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

    // Shopify orders route straight to a designer: the moment an order is ready to
    // assign (photos attached, figures resolved, has an email) we auto-assign it to
    // the best-ranked available designer, so it lands in their queue instead of
    // waiting for a VA to hand it out. If nobody is eligible (none rostered, all at
    // capacity, or no style match) it stays unassigned in ready_to_assign and the
    // Orders dashboard surfaces it as "Needs VA Review" with the reason why.
    // Skipped on a backfill (suppressCustomerEmail) so re-scanning history never
    // dumps old orders into designers' live queues or skews their daily capacity.
    let assignedTo: string | null = null;
    if (status === "ready_to_assign" && !needsReview && !shop.suppressCustomerEmail) {
      assignedTo = (
        await runAutoAssign(tx, { orderId, businessId: shop.businessId, assignedBy: null })
      ).assigned;
    }

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
        orderName: order.orderName,
        sourceName: order.sourceName,
        orderClass: klass,
        itemCount: items.length,
        hasEmail: !!email,
        photoCount: assetValues.length,
        needsReview,
        assignedTo,
        autoAssigned: assignedTo != null,
        figures: items.map((i) => ({ count: i.count, source: i.source, note: i.note, style: i.style })),
        // Add-on lines (tips/fees) deliberately not imported as order_items, logged
        // here so a real product that unexpectedly lacks a variant is auditable.
        ...(skippedAddOns.length ? { skippedAddOns } : {}),
      },
    });

    // Auto-send exception: queue the photo-request email only when we still need
    // photos AND this shop enables photo requests (false by default for Shopify —
    // photos come from checkout). A Shopify order in awaiting_photos is an anomaly
    // surfaced in the VA queue instead of emailed. Never on a backfill.
    if (
      status === "awaiting_photos" &&
      photoRequestEnabled(shop.config) &&
      !shop.suppressCustomerEmail
    ) {
      await queuePhotoRequest(tx, {
        id: orderId,
        businessId: shop.businessId,
        customerId,
        platformOrderId: order.platformOrderId,
        platformOrderName: order.orderName ?? order.platformOrderId,
        uploadToken,
      });
    }

    return "imported";
  });
}

/* --- webhook figure-count resolution ------------------------------------ */

/** Minimal GraphQL surface a resolver needs — satisfied by ShopifyClient. */
export type GraphqlRunner = {
  graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T>;
};

// Same field set as ORDERS_QUERY's node, fetched for ONE order by its GID. The
// REST webhook payload has no structured variant options (only a joined
// `variant_title` string), so we re-fetch via GraphQL to get selectedOptions and
// resolve figure count through the exact same path as the sync.
const ORDER_BY_ID_QUERY = `
query($id: ID!) {
  order(id: $id) {
    id
    name
    sourceName
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
}`;

/** Fetch one order's structured GraphQL representation by its numeric (legacy) id. */
export async function fetchShopifyOrder(
  client: GraphqlRunner,
  legacyResourceId: string,
): Promise<NormalizedOrder | null> {
  const data = await client.graphql<{ order: GqlOrder | null }>(ORDER_BY_ID_QUERY, {
    id: `gid://shopify/Order/${legacyResourceId}`,
  });
  return data.order ? normalizeGraphqlOrder(data.order) : null;
}

/**
 * Resolve a webhook order's line items to the SAME structured shape the sync
 * produces. The orders/create REST payload carries only `variant_title`
 * ("2 Figures / A3 Print") with no option names, so a name-based figure rule
 * can't match it. We re-fetch the order over GraphQL to get `selectedOptions`
 * (proper {name,value} pairs) and resolve exactly like the sync — one code path.
 *
 * Resilient by design: if the follow-up fetch fails or the order isn't visible
 * yet, we fall back to the REST-derived order so it still imports. That fallback
 * won't match a name-based rule, so the order lands unresolved in the review
 * queue rather than guessing — figure count drives payout.
 */
export async function resolveWebhookOrder(
  client: GraphqlRunner,
  fallback: NormalizedOrder,
): Promise<{ order: NormalizedOrder; resolution: "graphql" | "rest_fallback"; error?: string }> {
  try {
    const full = await fetchShopifyOrder(client, fallback.platformOrderId);
    if (full) return { order: full, resolution: "graphql" };
    return { order: fallback, resolution: "rest_fallback", error: "order not found via GraphQL" };
  } catch (e) {
    return { order: fallback, resolution: "rest_fallback", error: e instanceof Error ? e.message : String(e) };
  }
}

/* --- normalization ------------------------------------------------------ */
export function normalizeGraphqlOrder(o: GqlOrder): NormalizedOrder {
  return {
    platformOrderId: o.legacyResourceId,
    orderName: o.name ?? null,
    sourceName: o.sourceName ?? null,
    createdAt: new Date(o.createdAt),
    email: o.email ?? o.customer?.email ?? null,
    firstName: o.customer?.firstName ?? null,
    lastName: o.customer?.lastName ?? null,
    lineItems: o.lineItems.nodes.map((li) => {
      const attrs = li.customAttributes ?? [];
      return {
        sku: li.sku,
        title: li.title,
        variantTitle: li.variantTitle,
        digital: !li.requiresShipping,
        quantity: li.quantity,
        hasVariant: li.variant != null,
        selectedOptions: (li.variant?.selectedOptions ?? []).map((s) => ({ name: s.name, value: s.value })),
        properties: attrs
          .filter((a) => a.value != null && !isUrl(a.value))
          .map((a) => ({ name: a.key, value: a.value as string })),
        photoUrls: attrs.filter((a) => isUrl(a.value)).map((a) => a.value as string),
      };
    }),
  };
}

export function isUrl(v: string | null | undefined): boolean {
  return typeof v === "string" && /^https?:\/\//i.test(v.trim());
}

function summarizeOptions(li: NormalizedLineItem): string {
  const parts = [...li.selectedOptions, ...li.properties].map((o) => `${o.name}: ${o.value}`);
  return parts.length ? parts.join("; ") : (li.variantTitle ?? li.title ?? "");
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
