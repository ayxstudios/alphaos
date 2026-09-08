import { eq } from "drizzle-orm";

import type { Tx } from "@/lib/db";
import { getShopCredentials } from "@/lib/db/credentials";
import { activityLog, orders, printJobs, shops } from "@/lib/db/schema";
import {
  freshShopifyCredentials,
  fulfillShopifyOrderWithTracking,
  type ShopifyCredentials,
  type ShopifyFulfillmentResult,
} from "@/lib/integrations/shopify";
import { createEtsyReceiptShipment, type EtsyCredentials } from "@/lib/integrations/etsy";
import { runTransition, type OrderStatus } from "@/lib/orders/transitions";
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
 * Never throws for a platform writeback failure: that is recorded on the
 * print job (platformSyncError) exactly like the manual path, not raised.
 */
export async function applyReconcileShipment(
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
  const [order] = await tx
    .select({
      id: orders.id,
      businessId: orders.businessId,
      shopId: orders.shopId,
      source: orders.source,
      status: orders.status,
      platformOrderId: orders.platformOrderId,
      shopExternalId: shops.externalShopId,
    })
    .from(orders)
    .innerJoin(shops, eq(shops.id, orders.shopId))
    .where(eq(orders.id, input.orderId))
    .limit(1);
  if (!order) return;

  let shopifyResult: ShopifyFulfillmentResult | null = null;
  let etsyResult: unknown = null;
  let platformSyncError: string | null = null;

  if (order.source === "shopify") {
    try {
      const creds = (await getShopCredentials(tx, order.shopId)) as ShopifyCredentials;
      const fresh = await freshShopifyCredentials(creds);
      shopifyResult = await fulfillShopifyOrderWithTracking(order.shopId, order.platformOrderId, fresh, {
        trackingNumber: input.shipment.trackingNumber,
        trackingCompany: input.shipment.carrier ?? undefined,
        trackingUrl: input.shipment.trackingUrl ?? undefined,
        notifyCustomer: true,
        closeOrder: false,
      });
    } catch (error) {
      platformSyncError = error instanceof Error ? error.message : "Shopify fulfillment failed.";
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
  } else if (order.source === "etsy") {
    try {
      const creds = (await getShopCredentials(tx, order.shopId)) as EtsyCredentials;
      etsyResult = await createEtsyReceiptShipment({
        shopId: order.shopId,
        businessId: order.businessId,
        etsyShopId: creds.etsyShopId ?? order.shopExternalId,
        receiptId: order.platformOrderId,
        credentials: creds,
        trackingNumber: input.shipment.trackingNumber,
        trackingCompany: input.shipment.carrier ?? undefined,
      });
    } catch (error) {
      platformSyncError = error instanceof Error ? error.message : "Etsy shipment writeback failed.";
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
  }

  const now = new Date();
  await tx
    .update(printJobs)
    .set({
      trackingNumber: input.shipment.trackingNumber,
      trackingCompany: input.shipment.carrier ?? null,
      trackingUrl: input.shipment.trackingUrl ?? null,
      shopifyFulfillmentId: shopifyResult?.fulfillmentId ?? null,
      shopifySyncedAt: shopifyResult ? now : null,
      platformSyncedAt: shopifyResult || etsyResult ? now : null,
      platformSyncError,
      shippedAt: now,
      providerResponse: shopifyResult ?? etsyResult ?? undefined,
    })
    .where(eq(printJobs.id, input.printJobId));

  await tx.insert(activityLog).values({
    businessId: order.businessId,
    orderId: order.id,
    actorId: null,
    action: "print.reconcile_tracking_added",
    metadata: {
      provider: input.provider,
      providerOrderId: input.providerOrderId,
      trackingNumber: input.shipment.trackingNumber,
      platformSyncError,
      via: "print_reconcile",
    },
  });

  if (order.status === "printing") {
    await runTransition(tx, SYSTEM_ACTOR, {
      orderId: order.id,
      to: "shipped",
      expectedFrom: order.status as OrderStatus,
      metadata: { via: "print_reconcile", provider: input.provider, trackingNumber: input.shipment.trackingNumber },
    });
  }
}
