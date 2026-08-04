import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";

import { withSystemContext } from "@/lib/db";
import { getShopCredentials } from "@/lib/db/credentials";
import {
  shops,
  orders,
  orderItems,
  customers,
  activityLog,
} from "@/lib/db/schema";
import { queuePhotoRequest, flushQueued } from "@/lib/email/dispatch";
import { classifyOrder, photoRequestEnabled } from "@/lib/integrations/classify";
import { EtsyClient } from "./client";
import { resolveFigureCount, resolveStyle } from "./figures";
import { ReauthRequiredError } from "./errors";
import type {
  EtsyCredentials,
  EtsyIntegrationConfig,
  EtsyReceipt,
  EtsyReceiptsResponse,
  EtsyTransaction,
} from "./types";

const PAGE = 100;
const STALE_LOCK_MS = 10 * 60 * 1000;
const OVERLAP_SECS = 60 * 60; // re-scan 1h before the cursor for boundary safety
const FIRST_WINDOW_SECS = 60 * 24 * 60 * 60; // first sync: last 60 days (match Shopify)
const DEFAULT_TURNAROUND_DAYS = 3;

export type SyncSummary = {
  imported: number;
  skipped: number;
  failed: number;
  skippedRun?: "already_running" | "needs_reauth";
  errors: { receiptId: number; error: string }[];
};

export function getShopReceipts(
  client: EtsyClient,
  etsyShopId: string,
  opts: { minCreated?: number; limit: number; offset: number },
): Promise<EtsyReceiptsResponse> {
  const params = new URLSearchParams({
    limit: String(opts.limit),
    offset: String(opts.offset),
    sort_on: "created",
    sort_order: "asc",
  });
  if (opts.minCreated) params.set("min_created", String(opts.minCreated));
  return client.apiGet<EtsyReceiptsResponse>(
    `/shops/${etsyShopId}/receipts?${params.toString()}`,
  );
}

/**
 * Pull new receipts for a shop and map them to orders + order_items. Idempotent
 * (ON CONFLICT on (shop_id, platform_order_id)); each receipt commits in its own
 * transaction so a mid-run failure leaves a clean partial import that the next
 * run resumes. The sync cursor advances only after a fully successful run.
 *
 * `suppressCustomerEmail` (backfills) blocks every automated customer email: no
 * photo-request is queued at import, and the post-run flush is skipped.
 */
export async function syncShopReceipts(
  shopId: string,
  opts: { suppressCustomerEmail?: boolean } = {},
): Promise<SyncSummary> {
  const empty: SyncSummary = { imported: 0, skipped: 0, failed: 0, errors: [] };

  // 1. Claim the shop (concurrency guard) + load creds/config under a row lock.
  const claim = await withSystemContext(async (tx) => {
    await tx.execute(sql`select id from shops where id = ${shopId} for update`);
    const [shop] = await tx
      .select({
        id: shops.id,
        businessId: shops.businessId,
        externalShopId: shops.externalShopId,
        integrationConfig: shops.integrationConfig,
        slaConfig: shops.slaConfig,
      })
      .from(shops)
      .where(eq(shops.id, shopId));
    if (!shop) throw new Error(`Shop not found: ${shopId}`);

    const cfg = (shop.integrationConfig ?? {}) as EtsyIntegrationConfig;
    if (cfg.syncingSince && Date.now() - new Date(cfg.syncingSince).getTime() < STALE_LOCK_MS) {
      return { kind: "already_running" as const };
    }
    const creds = (await getShopCredentials(tx, shopId)) as EtsyCredentials;
    if (creds.status !== "connected") return { kind: "needs_reauth" as const };

    await tx
      .update(shops)
      .set({ integrationConfig: { ...cfg, syncingSince: new Date().toISOString() } })
      .where(eq(shops.id, shopId));

    return { kind: "ok" as const, shop, cfg, creds };
  });

  if (claim.kind === "already_running") return { ...empty, skippedRun: "already_running" };
  if (claim.kind === "needs_reauth") return { ...empty, skippedRun: "needs_reauth" };

  const { shop, cfg, creds } = claim;
  const etsyShopId = creds.etsyShopId ?? shop.externalShopId;
  const client = new EtsyClient(shopId, shop.businessId, creds);
  const summary: SyncSummary = { imported: 0, skipped: 0, failed: 0, errors: [] };
  let maxCreated = cfg.syncCursor ? Number(cfg.syncCursor) : 0;

  try {
    const minCreated = cfg.syncCursor
      ? Math.max(0, Number(cfg.syncCursor) - OVERLAP_SECS)
      : Math.floor(Date.now() / 1000) - FIRST_WINDOW_SECS;

    for (let offset = 0; ; offset += PAGE) {
      const page = await getShopReceipts(client, etsyShopId, { minCreated, limit: PAGE, offset });
      for (const receipt of page.results) {
        try {
          const result = await importReceipt({
            shopId,
            businessId: shop.businessId,
            slaConfig: shop.slaConfig as Record<string, unknown> | null,
            cfg,
            receipt,
            suppressCustomerEmail: !!opts.suppressCustomerEmail,
          });
          if (result === "imported") summary.imported++;
          else summary.skipped++;
          maxCreated = Math.max(maxCreated, receipt.created_timestamp);
        } catch (err) {
          summary.failed++;
          summary.errors.push({ receiptId: receipt.receipt_id, error: String(err) });
          console.log(
            JSON.stringify({
              ts: new Date().toISOString(),
              level: "error",
              integration: "etsy",
              shopId,
              event: "receipt_import_failed",
              receiptId: receipt.receipt_id,
              error: String(err),
            }),
          );
        }
      }
      if (page.results.length < PAGE) break;
    }

    // Success: advance the cursor and release the lock.
    await withSystemContext((tx) =>
      tx
        .update(shops)
        .set({
          integrationConfig: {
            ...cfg,
            syncCursor: String(maxCreated || Math.floor(Date.now() / 1000)),
            syncingSince: undefined,
          },
        })
        .where(eq(shops.id, shopId)),
    );

    // Auto-send the queued photo-request emails for this business. Best-effort:
    // a Gmail hiccup must not fail an otherwise-successful import run. Skipped
    // entirely on a backfill so no historical order gets emailed.
    if (summary.imported > 0 && !opts.suppressCustomerEmail) {
      await flushQueued(shop.businessId).catch((err) =>
        console.log(
          JSON.stringify({
            ts: new Date().toISOString(),
            level: "error",
            integration: "gmail",
            businessId: shop.businessId,
            event: "photo_request_flush_failed",
            error: String(err),
          }),
        ),
      );
    }
    return summary;
  } catch (err) {
    // Failure: release the lock but DO NOT advance the cursor (safe resume).
    await withSystemContext((tx) =>
      tx
        .update(shops)
        .set({ integrationConfig: { ...cfg, syncingSince: undefined } })
        .where(eq(shops.id, shopId)),
    );
    if (err instanceof ReauthRequiredError) return { ...summary, skippedRun: "needs_reauth" };
    throw err;
  }
}

/** Import one receipt in its own transaction (atomic; idempotent). */
async function importReceipt(args: {
  shopId: string;
  businessId: string;
  slaConfig: Record<string, unknown> | null;
  cfg: EtsyIntegrationConfig;
  receipt: EtsyReceipt;
  suppressCustomerEmail?: boolean;
}): Promise<"imported" | "skipped"> {
  const { shopId, businessId, slaConfig, cfg, receipt, suppressCustomerEmail } = args;
  const email = receipt.buyer_email?.trim().toLowerCase() || null;
  const [firstName, lastName] = splitName(receipt.name);
  const placedAt = new Date(receipt.created_timestamp * 1000);
  const dueAt = computeDueAt(placedAt, slaConfig);
  const uploadToken = randomUUID();

  // Resolve figures + style (pure) before touching the DB.
  const items = receipt.transactions.map((t) => {
    const fig = resolveFigureCount(t.variations, cfg);
    const style = resolveStyle(t.variations, cfg);
    return {
      transaction: t,
      figureCount: fig.count,
      figureCountSource: fig.source,
      figureNote: fig.note,
      style: style.style,
      options: (t.variations ?? []).map((v) => ({ name: v.formatted_name, value: v.formatted_value })),
    };
  });

  // Classify: Etsy has no draft orders, so only portrait vs fulfillment_only.
  const klass = classifyOrder({
    sourceName: null,
    lines: items.map((i) => ({ sku: i.transaction.sku, title: i.transaction.title })),
    config: cfg,
  });
  const status = klass === "fulfillment_only" ? ("fulfillment_only" as const) : ("awaiting_photos" as const);
  const needsReview =
    !email || (klass === "portrait" && items.some((i) => i.figureCountSource === "unresolved"));

  return withSystemContext(async (tx) => {
    // Upsert customer (per-business, by email).
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

    // Idempotent insert — skip if this receipt is already imported.
    const inserted = await tx
      .insert(orders)
      .values({
        businessId,
        shopId,
        customerId,
        platformOrderId: String(receipt.receipt_id),
        // Etsy's human-facing order number IS the receipt id — same value.
        platformOrderName: String(receipt.receipt_id),
        status,
        source: "etsy",
        placedAt,
        dueAt,
        uploadToken,
        needsReview,
      })
      .onConflictDoNothing({ target: [orders.shopId, orders.platformOrderId] })
      .returning({ id: orders.id });

    if (!inserted.length) return "skipped";
    const orderId = inserted[0].id;

    await tx.insert(orderItems).values(
      items.map((i) => ({
        businessId,
        orderId,
        sku: i.transaction.sku,
        title: i.transaction.title,
        variation: summarizeVariations(i.transaction),
        options: i.options,
        figureCount: i.figureCount,
        figureCountSource: i.figureCountSource,
        rawVariations: i.transaction.variations,
        style: i.style,
        productType: i.transaction.is_digital ? ("digital" as const) : ("physical" as const),
      })),
    );

    await tx.insert(activityLog).values({
      businessId,
      orderId,
      actorId: null, // system import
      action: "order.imported",
      fromState: null,
      toState: status,
      metadata: {
        source: "etsy",
        receiptId: receipt.receipt_id,
        orderClass: klass,
        itemCount: items.length,
        hasEmail: !!email,
        needsReview,
        figures: items.map((i) => ({
          count: i.figureCount,
          source: i.figureCountSource,
          note: i.figureNote,
        })),
      },
    });

    // Auto-send exception: queue the photo-request email (with the upload link),
    // only when this shop enables photo requests (true by default for Etsy) and
    // photos are actually needed. Actually sent by the flush. Never on a backfill.
    if (status === "awaiting_photos" && photoRequestEnabled(cfg) && !suppressCustomerEmail) {
      await queuePhotoRequest(tx, {
        id: orderId,
        businessId,
        customerId,
        platformOrderId: String(receipt.receipt_id),
        platformOrderName: String(receipt.receipt_id),
        uploadToken,
      });
    }

    return "imported";
  });
}

/* --- mapping helpers ---------------------------------------------------- */
function splitName(name: string | null): [string | null, string | null] {
  if (!name) return [null, null];
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return [parts[0], null];
  return [parts[0], parts.slice(1).join(" ")];
}

function summarizeVariations(t: EtsyTransaction): string {
  const vs = (t.variations ?? []).map((v) => `${v.formatted_name}: ${v.formatted_value}`);
  return vs.length ? vs.join("; ") : (t.title ?? "");
}

function computeDueAt(placedAt: Date, slaConfig: Record<string, unknown> | null): Date {
  const days =
    typeof slaConfig?.turnaroundDays === "number"
      ? (slaConfig.turnaroundDays as number)
      : DEFAULT_TURNAROUND_DAYS;
  return new Date(placedAt.getTime() + days * 24 * 60 * 60 * 1000);
}
