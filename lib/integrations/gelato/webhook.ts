import { createHmac, timingSafeEqual } from "node:crypto";

import type { NormalizedProviderOrder } from "@/lib/print/provider-types";
import type { GelatoWebhookEvent } from "./types";

/**
 * Gelato's own docs (dashboard.gelato.com/docs/webhooks/) describe the event
 * shapes and retry behaviour but do not document a signature header - the
 * webhook URL you register is the only secret Gelato is given. We defend it
 * two ways, either of which passes:
 *
 *  1. A shared secret in the URL: register the webhook as
 *     `.../api/webhooks/gelato?secret=<per-business token>` and we compare it
 *     in constant time against businesses.print_credentials.gelato.webhookSecret.
 *  2. If Gelato ever adds a signature header (`x-gelato-signature`, HMAC-SHA256
 *     of the raw body with the same secret), we verify that instead - so this
 *     keeps working without a code change if/when they add one.
 */
export function verifyGelatoWebhook(input: {
  rawBody: string;
  secret: string;
  querySecret: string | null;
  signatureHeader: string | null;
}): boolean {
  const { rawBody, secret, querySecret, signatureHeader } = input;
  if (!secret) return false;

  if (signatureHeader) {
    const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
    const a = Buffer.from(signatureHeader);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  if (querySecret) {
    const a = Buffer.from(querySecret);
    const b = Buffer.from(secret);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  return false;
}

export function normalizeGelatoWebhookEvent(evt: GelatoWebhookEvent): NormalizedProviderOrder {
  const shipments = evt.items.flatMap((item) =>
    (item.fulfillments ?? []).map((f) => ({
      trackingNumber: f.trackingCode,
      carrier: f.shipmentMethodName ?? f.shipmentMethodUid ?? null,
      trackingUrl: f.trackingUrl,
      shippedAt: null,
    })),
  );
  const statusMap: Record<string, NormalizedProviderOrder["status"]> = {
    created: "created",
    passed: "created",
    printed: "printed",
    shipped: "shipped",
    delivered: "delivered",
    failed: "failed",
    canceled: "canceled",
  };
  return {
    provider: "gelato",
    providerOrderId: evt.orderId,
    referenceId: evt.orderReferenceId ?? null,
    status: statusMap[evt.fulfillmentStatus] ?? "created",
    rawStatus: evt.fulfillmentStatus,
    reason:
      evt.fulfillmentStatus === "failed" || evt.fulfillmentStatus === "canceled"
        ? `Gelato reported the order as ${evt.fulfillmentStatus}.`
        : null,
    shipments,
    raw: evt,
  };
}
