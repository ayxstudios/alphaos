import { eq, inArray } from "drizzle-orm";

import type { Tx } from "@/lib/db";
import { getShopCredentials } from "@/lib/db/credentials";
import { activityLog, orders, printJobs, shops } from "@/lib/db/schema";
import {
  freshShopifyCredentials,
  fulfillShopifyOrderWithTracking,
  updateShopifyFulfillmentTracking,
  type ShopifyCredentials,
  type ShopifyFulfillmentResult,
} from "@/lib/integrations/shopify";
import { createEtsyReceiptShipment, type EtsyCredentials } from "@/lib/integrations/etsy";
import { runTransition } from "@/lib/orders/transitions";
import {
  emailedTrackingNumbers,
  loadPrintParts,
  planShipmentNotice,
  queueShippedEmail,
  type PrintPart,
  type ShipmentNotice,
} from "@/lib/print/parts";
import type { ReconcileSource } from "@/lib/print/reconcile-ledger";
import { claimReconcileEvent } from "@/lib/print/reconcile-ledger";
import type { NormalizedShipment } from "@/lib/print/provider-types";

const SYSTEM_ACTOR = { id: "system", role: "system" as const };

/**
 * Reconciliation's own version of the tracking write in
 * app/(app)/orders/actions.ts `addTrackingAndCompleteOrder` (that file is
 * outside this task's ownership). Same shape - write the print_jobs row,
 * best-effort platform writeback, transition printing -> shipped - but driven
 * by a provider-confirmed shipment discovered by the reconcile sweep/webhook
 * instead of a VA typing it in, and run as the system actor.
 *
 * Split in two since an order can be several parts at the printer (lib/print/parts.ts): recordPartShipment writes
 * one part's parcel, settleOrderShipment then looks at every part once and does the writeback, the transition and the
 * buyer's email for all of them together.
 */
export async function recordPartShipment(
  tx: Tx,
  input: {
    businessId: string;
    orderId: string;
    printJobId: string;
    provider: "gelato" | "lumaprints";
    providerOrderId: string;
    shipment: NormalizedShipment;
  },
): Promise<void> {
  const now = new Date();
  const said = input.shipment.shippedAt ? new Date(input.shipment.shippedAt) : null;
  // When the provider says it shipped (the 3-day clock of a split order runs from here), else now.
  const shippedAt = said && !Number.isNaN(said.getTime()) && said <= now ? said : now;
  await tx
    .update(printJobs)
    .set({
      trackingNumber: input.shipment.trackingNumber,
      trackingCompany: input.shipment.carrier ?? null,
      trackingUrl: input.shipment.trackingUrl ?? null,
      shippedAt,
    })
    .where(eq(printJobs.id, input.printJobId));

  await tx.insert(activityLog).values({
    businessId: input.businessId,
    orderId: input.orderId,
    actorId: null,
    action: "print.reconcile_tracking_added",
    metadata: {
      provider: input.provider,
      providerOrderId: input.providerOrderId,
      trackingNumber: input.shipment.trackingNumber,
      via: "print_reconcile",
    },
  });
}

type SettleOrder = {
  id: string;
  businessId: string;
  shopId: string;
  source: string;
  status: string;
  customerId: string | null;
  platformOrderId: string;
  platformOrderName: string | null;
  shopExternalId: string | null;
};

/**
 * After every part of a printing order was looked at: once every part has tracking, write it back to the store,
 * move the order to shipped and email the buyer every number (one email). Parts shipping more than PART_WAIT_MS
 * apart: the buyer hears about the shipped ones then (the order stays printing) and gets a short email for the rest
 * later. Each writeback and early email is claimed in the reconcile ledger, and the shipped email's dedupe key carries
 * its numbers, so nothing is sent twice. Never throws for a platform writeback failure: that is recorded on the print
 * job (platformSyncError) exactly like the manual path, not raised.
 */
export async function settleOrderShipment(
  tx: Tx,
  input: { businessId: string; orderId: string; source: ReconcileSource; now?: Date },
): Promise<ShipmentNotice["kind"] | null> {
  const [order] = await tx
    .select({
      id: orders.id,
      businessId: orders.businessId,
      shopId: orders.shopId,
      source: orders.source,
      status: orders.status,
      customerId: orders.customerId,
      platformOrderId: orders.platformOrderId,
      platformOrderName: orders.platformOrderName,
      shopExternalId: shops.externalShopId,
    })
    .from(orders)
    .innerJoin(shops, eq(shops.id, orders.shopId))
    .where(eq(orders.id, input.orderId))
    .limit(1);
  if (!order || order.status !== "printing") return null;

  const parts = await loadPrintParts(tx, order.id);
  const notice = planShipmentNotice(parts, await emailedTrackingNumbers(tx, order.id), input.now);
  if (notice.kind === "none" || notice.kind === "wait") return notice.kind;

  await writeBackParts(tx, order, parts, input.source);
  const tracked = parts.filter((p) => p.trackingNumber);
  const numbers = tracked.map((p) => p.trackingNumber!);

  if (notice.kind === "all") {
    // The shipped email (every number not yet emailed) is queued by the transition.
    await runTransition(tx, SYSTEM_ACTOR, {
      orderId: order.id,
      to: "shipped",
      expectedFrom: "printing",
      metadata: {
        via: "print_reconcile",
        provider: tracked[0]?.provider,
        trackingNumber: numbers[0],
        ...(numbers.length > 1 ? { trackingNumbers: numbers } : {}),
      },
    });
    return "all";
  }

  const early = notice.untold.map((p) => p.trackingNumber!).sort();
  const claimed = await claimReconcileEvent(tx, {
    businessId: order.businessId,
    orderId: order.id,
    printJobId: notice.untold[0].id,
    provider: notice.untold[0].provider,
    eventKey: `${order.id}:shipped_early:${early.join("+")}`,
    outcome: "shipped",
    source: input.source,
    payload: { trackingNumbers: early },
  });
  if (claimed) {
    const messageId = await queueShippedEmail(tx, order);
    await tx.insert(activityLog).values({
      businessId: order.businessId,
      orderId: order.id,
      actorId: null,
      action: "print.reconcile_part_shipped",
      metadata: { trackingNumbers: early, messageId, waitingParts: parts.length - tracked.length, via: "print_reconcile" },
    });
  }
  return "early";
}

/**
 * Store writeback for the tracked parts not written yet. Shopify: one fulfillment carrying every number (a later
 * part updates the fulfillment the first one made, since the first covered all the fulfillable line items). Etsy:
 * one shipment per parcel, its API takes one number per call.
 */
async function writeBackParts(tx: Tx, order: SettleOrder, parts: PrintPart[], source: ReconcileSource): Promise<void> {
  if (order.source !== "shopify" && order.source !== "etsy") return;
  const tracked = parts.filter((p) => p.trackingNumber);
  const mine: PrintPart[] = [];
  for (const part of tracked) {
    if (part.platformSyncedAt || part.platformSyncError) continue;
    const claimed = await claimReconcileEvent(tx, {
      businessId: order.businessId,
      orderId: order.id,
      printJobId: part.id,
      provider: part.provider,
      eventKey: `${part.id}:writeback:${part.trackingNumber}`,
      outcome: "writeback",
      source,
      payload: { trackingNumber: part.trackingNumber },
    });
    if (claimed) mine.push(part);
  }
  if (!mine.length) return;

  const now = new Date();
  const errors: string[] = [];
  if (order.source === "shopify") {
    let shopifyResult: ShopifyFulfillmentResult | null = null;
    let platformSyncError: string | null = null;
    const made = tracked.find((p) => p.shopifyFulfillmentId)?.shopifyFulfillmentId ?? null;
    try {
      const creds = (await getShopCredentials(tx, order.shopId)) as ShopifyCredentials;
      const fresh = await freshShopifyCredentials(creds);
      const tracking = {
        trackingNumber: tracked[0].trackingNumber!,
        trackingCompany: tracked[0].trackingCompany ?? undefined,
        trackingUrl: tracked[0].trackingUrl ?? undefined,
        trackingNumbers: tracked.map((p) => p.trackingNumber!),
        trackingUrls: tracked.map((p) => p.trackingUrl).filter((u): u is string => !!u),
        notifyCustomer: true,
        closeOrder: false,
      };
      shopifyResult = made
        ? await updateShopifyFulfillmentTracking(order.shopId, made, fresh, tracking)
        : await fulfillShopifyOrderWithTracking(order.shopId, order.platformOrderId, fresh, tracking);
    } catch (error) {
      platformSyncError = error instanceof Error ? error.message : "Shopify fulfillment failed.";
      errors.push(platformSyncError);
      console.log(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: "warn",
          integration: "shopify",
          event: "reconcile_fulfillment_writeback_failed",
          shopId: order.shopId,
          orderId: order.id,
          error: platformSyncError,
        }),
      );
    }
    await tx
      .update(printJobs)
      .set({
        shopifyFulfillmentId: shopifyResult?.fulfillmentId ?? null,
        shopifySyncedAt: shopifyResult ? now : null,
        platformSyncedAt: shopifyResult ? now : null,
        platformSyncError,
      })
      .where(inArray(printJobs.id, mine.map((p) => p.id)));
  } else {
    for (const part of mine) {
      let platformSyncError: string | null = null;
      try {
        const creds = (await getShopCredentials(tx, order.shopId)) as EtsyCredentials;
        await createEtsyReceiptShipment({
          shopId: order.shopId,
          businessId: order.businessId,
          etsyShopId: creds.etsyShopId ?? order.shopExternalId ?? "",
          receiptId: order.platformOrderId,
          credentials: creds,
          trackingNumber: part.trackingNumber!,
          trackingCompany: part.trackingCompany ?? undefined,
        });
      } catch (error) {
        platformSyncError = error instanceof Error ? error.message : "Etsy shipment writeback failed.";
        errors.push(platformSyncError);
        console.log(
          JSON.stringify({
            ts: new Date().toISOString(),
            level: "warn",
            integration: "etsy",
            event: "reconcile_shipment_writeback_failed",
            shopId: order.shopId,
            orderId: order.id,
            error: platformSyncError,
          }),
        );
      }
      await tx
        .update(printJobs)
        .set({ platformSyncedAt: platformSyncError ? null : now, platformSyncError })
        .where(eq(printJobs.id, part.id));
    }
  }

  await tx.insert(activityLog).values({
    businessId: order.businessId,
    orderId: order.id,
    actorId: null,
    action: "print.reconcile_store_tracking",
    metadata: {
      platform: order.source,
      trackingNumbers: mine.map((p) => p.trackingNumber),
      platformSyncError: errors[0] ?? null,
      via: "print_reconcile",
    },
  });
}
