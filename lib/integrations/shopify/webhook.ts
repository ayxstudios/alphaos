import { createHmac, timingSafeEqual } from "node:crypto";

import type { NormalizedVariation } from "../figures";
import { isUrl, type NormalizedOrder } from "./orders";

/** Verify a Shopify webhook HMAC (base64 SHA-256 of the raw body). */
export function verifyShopifyHmac(
  rawBody: string,
  hmacHeader: string | null,
  secret: string,
): boolean {
  if (!hmacHeader) return false;
  const digest = createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
  const a = Buffer.from(digest);
  const b = Buffer.from(hmacHeader);
  return a.length === b.length && timingSafeEqual(a, b);
}

/* --- REST orders/create payload (subset) -------------------------------- */
type RestProperty = { name: string; value: string | null };
type RestLineItem = {
  sku: string | null;
  title: string | null;
  variant_title: string | null;
  quantity: number;
  requires_shipping: boolean;
  properties?: RestProperty[];
};
export type ShopifyWebhookOrder = {
  id: number;
  created_at: string;
  email: string | null;
  customer?: { first_name: string | null; last_name: string | null; email: string | null } | null;
  line_items: RestLineItem[];
};

/** Map the orders/create webhook JSON to our NormalizedOrder. */
export function normalizeWebhookOrder(payload: ShopifyWebhookOrder): NormalizedOrder {
  return {
    platformOrderId: String(payload.id),
    createdAt: new Date(payload.created_at),
    email: payload.email ?? payload.customer?.email ?? null,
    firstName: payload.customer?.first_name ?? null,
    lastName: payload.customer?.last_name ?? null,
    lineItems: (payload.line_items ?? []).map((li) => {
      const props = li.properties ?? [];
      const options: NormalizedVariation[] = props
        .filter((p) => p.value != null && !isUrl(p.value))
        .map((p) => ({ name: p.name, value: p.value as string }));
      if (li.variant_title) options.push({ name: "Variant", value: li.variant_title });
      return {
        sku: li.sku,
        title: li.title,
        variantTitle: li.variant_title,
        digital: !li.requires_shipping,
        quantity: li.quantity,
        options,
        photoUrls: props.filter((p) => isUrl(p.value)).map((p) => p.value as string),
      };
    }),
  };
}
