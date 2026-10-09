import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";

import { withSystemContext } from "@/lib/db";
import { getShopCredentials, setShopCredentials } from "@/lib/db/credentials";
import { shops, orders, orderItems, customers, activityLog } from "@/lib/db/schema";
import { queueStageEmail } from "@/lib/email/dispatch";
import { reconcileManualOrder } from "@/lib/orders/reconcile";
import { isBeforeBackfillCutoff } from "@/lib/orders/archive";
import { normalizeEtsyReceiptAddress, upsertOrderShippingAddress } from "@/lib/shipping/address";
import { failJobRun, finishJobRun, JOB_NAMES, startJobRun } from "@/lib/jobs/ledger";
import { etsyImportItems } from "./receipt-review";
import { EtsyClient } from "./client";
import { ReauthRequiredError } from "./errors";
import type {
  EtsyCredentials,
  EtsyIntegrationConfig,
  EtsyReceipt,
  EtsyReceiptsResponse,
} from "./types";

const PAGE = 100;
const STALE_LOCK_MS = 10 * 60 * 1000;
const OVERLAP_SECS = 60 * 60; // re-scan 1h before the cursor for boundary safety
const FIRST_WINDOW_SECS = 60 * 24 * 60 * 60; // first sync: last 60 days (match Shopify)
// A walk stops after the page that crosses this budget and saves resumeWalk, so a big first sync
// (a 1,600-receipt shop) lands over several runs instead of dying at Vercel's 60 s and restarting from zero.
const DEFAULT_BUDGET_MS = 40 * 1000;
const DEFAULT_TURNAROUND_DAYS = 3;

function isNumericShopId(value: string | undefined): value is string {
  return typeof value === "string" && /^\d+$/.test(value);
}

export type SyncSummary = {
  imported: number;
  archived: number;
  skipped: number;
  failed: number;
  reconciled?: number; // manual orders matched + promoted in place
  skippedRun?: "already_running" | "needs_reauth";
  /** The walk stopped on its time budget; call again to continue from nextOffset. */
  paused?: { nextOffset: number };
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
 * Etsy imports never send automated email (a VA completes details first), so
 * there is no email-suppression flag as there is for Shopify backfills.
 */
export async function syncShopReceipts(
  shopId: string,
  opts: { mode?: "sync" | "backfill"; trigger?: "cron" | "manual" | "backfill"; budgetMs?: number } = {},
): Promise<SyncSummary> {
  const empty: SyncSummary = { imported: 0, archived: 0, skipped: 0, failed: 0, errors: [] };

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
      return { kind: "already_running" as const, shop, cfg };
    }
    const creds = (await getShopCredentials(tx, shopId)) as EtsyCredentials;
    if (creds.status !== "connected") return { kind: "needs_reauth" as const, shop, cfg };

    await tx
      .update(shops)
      .set({ integrationConfig: { ...cfg, syncingSince: new Date().toISOString() } })
      .where(eq(shops.id, shopId));

    return { kind: "ok" as const, shop, cfg, creds };
  });

  const trigger = opts.trigger ?? (opts.mode === "backfill" ? "backfill" : "manual");
  const jobRunId = await startJobRun({
    jobName: JOB_NAMES.shopSync,
    scope: { businessId: claim.shop.businessId, shopId },
    metadata: { platform: "etsy", trigger, mode: opts.mode ?? "sync" },
  });

  if (claim.kind === "already_running") {
    await finishJobRun(jobRunId, {
      status: "partial",
      itemsProcessed: 0,
      itemsFailed: 0,
      metadata: { platform: "etsy", trigger, skippedRun: "already_running", syncingSince: claim.cfg.syncingSince ?? null },
    });
    return { ...empty, skippedRun: "already_running" };
  }
  if (claim.kind === "needs_reauth") {
    await finishJobRun(jobRunId, {
      status: "failed",
      itemsProcessed: 0,
      itemsFailed: 1,
      error: "Etsy shop needs reauthorization",
      metadata: { platform: "etsy", trigger, skippedRun: "needs_reauth" },
    });
    return { ...empty, skippedRun: "needs_reauth" };
  }

  const { shop, cfg, creds } = claim;
  const client = new EtsyClient(shopId, shop.businessId, creds);
  let etsyShopId = isNumericShopId(creds.etsyShopId) ? creds.etsyShopId : undefined;
  if (!etsyShopId) {
    etsyShopId = await client.discoverShopId();
    await withSystemContext((tx) =>
      setShopCredentials(tx, shopId, { ...client.credentials, etsyShopId }),
    );
  }
  const summary: SyncSummary = { imported: 0, archived: 0, skipped: 0, failed: 0, errors: [] };
  let maxCreated = cfg.syncCursor ? Number(cfg.syncCursor) : 0;
  const startedAt = Date.now();
  const budgetMs = Math.max(5_000, opts.budgetMs ?? DEFAULT_BUDGET_MS);
  let paused = false;
  let nextOffset = 0;

  try {
    const resume = cfg.resumeWalk;
    const minCreated = resume
      ? resume.minCreated
      : cfg.syncCursor
        ? Math.max(0, Number(cfg.syncCursor) - OVERLAP_SECS)
        : Math.floor(Date.now() / 1000) - FIRST_WINDOW_SECS;

    for (let offset = resume?.offset ?? 0; ; offset += PAGE) {
      const page = await getShopReceipts(client, etsyShopId, { minCreated, limit: PAGE, offset });
      for (const receipt of page.results) {
        try {
          const result = await importReceipt({
            shopId,
            businessId: shop.businessId,
            config: cfg,
            slaConfig: shop.slaConfig as Record<string, unknown> | null,
            receipt,
            via: opts.mode ?? "sync",
          });
          if (result === "imported" || result === "archived") {
            summary.imported++;
            if (result === "archived") summary.archived++;
          }
          else if (result === "reconciled") summary.reconciled = (summary.reconciled ?? 0) + 1;
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
      if (Date.now() - startedAt > budgetMs) {
        paused = true;
        nextOffset = offset + PAGE;
        break;
      }
    }

    // Success: advance the cursor (or save where a budget-paused walk resumes), stamp health, release the lock.
    const lastSyncAt = new Date().toISOString();
    const nextConfig = paused
      ? { ...cfg, resumeWalk: { minCreated, offset: nextOffset }, syncingSince: undefined, lastSyncAt }
      : {
          ...cfg,
          resumeWalk: undefined,
          syncCursor: String(maxCreated || Math.floor(Date.now() / 1000)),
          syncingSince: undefined,
          lastSyncAt,
        };
    await withSystemContext((tx) =>
      tx.update(shops).set({ integrationConfig: nextConfig }).where(eq(shops.id, shopId)),
    );
    if (paused) summary.paused = { nextOffset };

    // Etsy sends no automated customer email (photos come after a VA completes
    // details), so there is nothing to flush here.
    await finishJobRun(jobRunId, {
      status: summary.failed > 0 ? "partial" : "ok",
      itemsProcessed: summary.imported + summary.skipped + summary.failed + (summary.reconciled ?? 0),
      itemsFailed: summary.failed,
      metadata: {
        platform: "etsy",
        trigger,
        mode: opts.mode ?? "sync",
        imported: summary.imported,
        archived: summary.archived,
        skipped: summary.skipped,
        reconciled: summary.reconciled ?? 0,
        failed: summary.failed,
        failedReceipts: summary.errors.slice(0, 50),
        syncCursor: paused ? (cfg.syncCursor ?? null) : String(maxCreated || Math.floor(Date.now() / 1000)),
        paused,
        resumeWalk: paused ? { minCreated, offset: nextOffset } : null,
        lastSyncAt,
      },
    });
    return summary;
  } catch (err) {
    // Failure: release the lock but DO NOT advance the cursor (safe resume).
    await withSystemContext((tx) =>
      tx
        .update(shops)
        .set({ integrationConfig: { ...cfg, syncingSince: undefined } })
        .where(eq(shops.id, shopId)),
    );
    if (err instanceof ReauthRequiredError) {
      await finishJobRun(jobRunId, {
        status: "failed",
        itemsProcessed: summary.imported + summary.skipped + summary.failed + (summary.reconciled ?? 0),
        itemsFailed: summary.failed + 1,
        error: "Etsy shop needs reauthorization",
        metadata: { platform: "etsy", trigger, skippedRun: "needs_reauth", failedReceipts: summary.errors.slice(0, 50) },
      });
      return { ...summary, skippedRun: "needs_reauth" };
    }
    await failJobRun(jobRunId, err, { platform: "etsy", trigger, mode: opts.mode ?? "sync", failedReceipts: summary.errors.slice(0, 50) });
    throw err;
  }
}

/**
 * Import ONE Etsy receipt as an order HEADER only — deliberately minimal.
 *
 * Etsy's job is "never miss an order". Figure count and style live in
 * personalization / notes that need a human to read, so we do NOT resolve them
 * here: no figure/style resolution, no needs_review (nothing was attempted), no
 * customer email. The full receipt is stored in raw_import, and the order lands
 * in `awaiting_details` for a VA to complete via the manual form.
 *
 * One thing IS carried over per transaction (Yousif 2026-10-05, same rule as
 * Shopify line-item properties): a bare order_items row with the buyer's chosen
 * variations as options (Background, Size, Personalization…), sku and title, so
 * the card and complete form show them without digging in raw_import.
 *
 * Idempotent (ON CONFLICT on shop_id+platform_order_id); reconciles onto a
 * VA-entered manual order when one already exists (fills blanks, never overwrites).
 */
async function importReceipt(args: {
  shopId: string;
  businessId: string;
  config: EtsyIntegrationConfig;
  slaConfig: Record<string, unknown> | null;
  receipt: EtsyReceipt;
  via: "sync" | "backfill";
}): Promise<"imported" | "archived" | "skipped" | "reconciled"> {
  const { shopId, businessId, config, slaConfig, receipt, via } = args;
  const email = receipt.buyer_email?.trim().toLowerCase() || null;
  const [firstName, lastName] = splitName(receipt.name);
  const placedAt = new Date(receipt.created_timestamp * 1000);
  const dueAt = computeDueAt(placedAt, slaConfig);
  const archived = isBeforeBackfillCutoff(placedAt, config);
  const archivedAt = archived ? new Date() : null;
  const shippingAddress = normalizeEtsyReceiptAddress(receipt);
  const initialStatus = etsyReceiptToInitialStatus(receipt);

  return withSystemContext(async (tx) => {
    // Customer, only when Etsy actually gave us an email.
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

    // Reconcile with a VA-entered manual order (Etsy receipt id is the number a
    // VA types) before inserting. Fills blanks only; the VA's data always wins.
    const rec = await reconcileManualOrder(tx, {
      shopId,
      businessId,
      realPlatformOrderId: String(receipt.receipt_id),
      orderNumber: String(receipt.receipt_id),
      customerId,
      photoUrls: [], // Etsy has no photos at import
      rawImport: receipt,
      importItems: etsyImportItems(receipt),
    });
    if (rec.reconciled) {
      await upsertOrderShippingAddress(tx, {
        businessId,
        orderId: rec.orderId!,
        source: "platform",
        address: shippingAddress,
      });
      return "reconciled";
    }

    const inserted = await tx
      .insert(orders)
      .values({
        businessId,
        shopId,
        customerId,
        // Etsy's human-facing order number IS the receipt id — same value for both.
        platformOrderId: String(receipt.receipt_id),
        platformOrderName: String(receipt.receipt_id),
        status: initialStatus,
        source: "etsy",
        placedAt,
        dueAt,
        uploadToken: randomUUID(),
        needsReview: false,
        rawImport: receipt,
        archivedAt,
        archiveReason: archived ? "Imported before shop backfill cutoff" : null,
      })
      .onConflictDoNothing({ target: [orders.shopId, orders.platformOrderId] })
      .returning({ id: orders.id });

    if (!inserted.length) return "skipped";
    const orderId = inserted[0].id;

    const importItems = etsyImportItems(receipt);
    if (importItems.length) {
      await tx.insert(orderItems).values(
        importItems.map((item) => ({
          businessId,
          orderId,
          sku: item.sku,
          title: item.title,
          options: item.options.length ? item.options : null,
          rawVariations: item.rawVariations,
          productType: item.productType,
        })),
      );
    }

    await upsertOrderShippingAddress(tx, {
      businessId,
      orderId,
      source: "platform",
      address: shippingAddress,
    });

    await tx.insert(activityLog).values({
      businessId,
      orderId,
      actorId: null, // system import
      action: "order.imported",
      fromState: null,
      toState: initialStatus,
      metadata: {
        source: "etsy",
        via,
        receiptId: receipt.receipt_id,
        hasEmail: !!email,
        transactionCount: receipt.transactions?.length ?? 0,
        archived,
        backfillCutoffAt: config.backfillCutoffAt ?? null,
        etsyStatus: receipt.status ?? null,
        etsyIsShipped: receipt.is_shipped ?? null,
      },
    });

    // Order-received acknowledgement (stage email, lib/email/dispatch.ts).
    // Etsy otherwise sends NO automated email at import (a VA completes
    // figure/style/photos first — this is unrelated to that, just a warm "we
    // got it"), and it's a no-op whenever Etsy didn't give us a buyer email
    // (email_r scope), which is most receipts today. Never on a backfill, an
    // archived (pre-cutoff) import, or an order Etsy says is already
    // shipped/completed/cancelled (nothing to acknowledge on history).
    if (email && !archived && via !== "backfill" && initialStatus === "awaiting_details") {
      await queueStageEmail(
        tx,
        { id: orderId, businessId, customerId, platformOrderId: String(receipt.receipt_id), platformOrderName: String(receipt.receipt_id) },
        "order_received",
      );
    }

    return archived ? "archived" : "imported";
  });
}

/* --- mapping helpers ---------------------------------------------------- */
function splitName(name: string | null): [string | null, string | null] {
  if (!name) return [null, null];
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return [parts[0], null];
  return [parts[0], parts.slice(1).join(" ")];
}

/**
 * The order status a receipt should land in AT IMPORT, honouring Etsy's own
 * fulfilment state. Almost every receipt is still open work and gets the
 * usual `awaiting_details` (a VA fills in figure/style/photos); the
 * exception is a receipt Etsy already says is done — most commonly a
 * backfilled historical order that was fulfilled before AlphaOS ever synced
 * it. Those must NOT enter the queue as unshipped work, or they inflate the
 * overdue count forever (2026-09-12 overdue-sweep: 82 PixArt backfill
 * orders were exactly this).
 */
export function etsyReceiptToInitialStatus(receipt: EtsyReceipt): "complete" | "cancelled" | "awaiting_details" {
  const status = (receipt.status ?? "").trim().toLowerCase();
  if (status === "canceled" || status === "cancelled") return "cancelled";
  if (status === "fully refunded" || status === "refunded") return "cancelled";
  if (receipt.is_shipped || status === "completed") return "complete";
  return "awaiting_details";
}

function computeDueAt(placedAt: Date, slaConfig: Record<string, unknown> | null): Date {
  const days =
    typeof slaConfig?.turnaroundDays === "number"
      ? (slaConfig.turnaroundDays as number)
      : DEFAULT_TURNAROUND_DAYS;
  return new Date(placedAt.getTime() + days * 24 * 60 * 60 * 1000);
}
