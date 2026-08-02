import { NextResponse, type NextRequest } from "next/server";
import { after } from "next/server";
import { and, eq } from "drizzle-orm";

import { withSystemContext } from "@/lib/db";
import { getShopCredentials } from "@/lib/db/credentials";
import { flushQueued } from "@/lib/email/dispatch";
import { shops } from "@/lib/db/schema";
import {
  verifyShopifyHmac,
  normalizeWebhookOrder,
  importShopifyOrder,
  type ShopifyWebhookOrder,
  type ShopifyCredentials,
  type ShopifyIntegrationConfig,
  type ShopContext,
} from "@/lib/integrations/shopify";

export const runtime = "nodejs";

/**
 * Shopify orders/create webhook. Verifies the per-shop HMAC against the raw body
 * and rejects anything that fails, then responds 200 immediately and imports the
 * order after the response (Next's `after`) so Shopify never waits on our DB.
 */
export async function POST(req: NextRequest) {
  const raw = await req.text();
  const hmac = req.headers.get("x-shopify-hmac-sha256");
  const domain = req.headers.get("x-shopify-shop-domain");
  const topic = req.headers.get("x-shopify-topic");

  if (!domain) return new NextResponse("bad request", { status: 400 });

  // Look up the shop (by its myshopify domain) and its webhook secret.
  const found = await withSystemContext(async (tx) => {
    const [shop] = await tx
      .select({
        id: shops.id,
        businessId: shops.businessId,
        slaConfig: shops.slaConfig,
        integrationConfig: shops.integrationConfig,
      })
      .from(shops)
      .where(and(eq(shops.platform, "shopify"), eq(shops.externalShopId, domain)));
    if (!shop) return null;
    const creds = (await getShopCredentials(tx, shop.id)) as ShopifyCredentials;
    return { shop, secret: creds.webhookSecret };
  });

  // Reject unknown shops or bad signatures.
  if (!found?.secret) return new NextResponse("unknown shop", { status: 401 });
  if (!verifyShopifyHmac(raw, hmac, found.secret)) {
    return new NextResponse("invalid signature", { status: 401 });
  }

  if (topic !== "orders/create") return new NextResponse("ignored", { status: 200 });

  let payload: ShopifyWebhookOrder;
  try {
    payload = JSON.parse(raw) as ShopifyWebhookOrder;
  } catch {
    return new NextResponse("bad json", { status: 400 });
  }

  const ctx: ShopContext = {
    id: found.shop.id,
    businessId: found.shop.businessId,
    slaConfig: found.shop.slaConfig as Record<string, unknown> | null,
    config: (found.shop.integrationConfig ?? {}) as ShopifyIntegrationConfig,
  };

  // Process after the 200 is sent. Errors are logged; the order can be
  // re-imported idempotently by a later sync.
  after(async () => {
    try {
      const result = await importShopifyOrder({ shop: ctx, order: normalizeWebhookOrder(payload), via: "webhook" });
      // Auto-send the photo request in near-real-time for a webhook import.
      if (result === "imported") await flushQueued(ctx.businessId);
      console.log(
        JSON.stringify({
          ts: new Date().toISOString(),
          integration: "shopify",
          shopId: ctx.id,
          event: "webhook_processed",
          platformOrderId: String(payload.id),
          result,
        }),
      );
    } catch (err) {
      console.log(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: "error",
          integration: "shopify",
          shopId: ctx.id,
          event: "webhook_import_failed",
          platformOrderId: String(payload.id),
          error: String(err),
        }),
      );
    }
  });

  return new NextResponse("ok", { status: 200 });
}
