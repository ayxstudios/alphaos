import { NextResponse, type NextRequest } from "next/server";
import { after } from "next/server";
import { and, eq } from "drizzle-orm";

import { withSystemContext } from "@/lib/db";
import { getShopCredentials } from "@/lib/db/credentials";
import { flushQueued } from "@/lib/email/dispatch";
import { failJobRun, finishJobRun, JOB_NAMES, startJobRun } from "@/lib/jobs/ledger";
import { shops } from "@/lib/db/schema";
import {
  verifyShopifyHmac,
  normalizeWebhookOrder,
  importShopifyOrder,
  resolveWebhookOrder,
  ShopifyClient,
  shopifyWebhookHmacKey,
  isShopifyConnected,
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

  // Look up the shop (by its myshopify domain) and its full credentials.
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
    return { shop, creds };
  });

  if (!found) return new NextResponse("unknown shop", { status: 401 });

  // The HMAC key is the client secret for Dev Dashboard apps, or the dedicated
  // webhook secret for legacy custom apps. Reject unconfigured shops / bad sigs.
  const hmacKey = shopifyWebhookHmacKey(found.creds);
  if (!hmacKey) return new NextResponse("unknown shop", { status: 401 });
  if (!verifyShopifyHmac(raw, hmac, hmacKey)) {
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
    const runId = await startJobRun({
      jobName: JOB_NAMES.shopifyWebhookImport,
      scope: { businessId: ctx.businessId, shopId: ctx.id },
      metadata: {
        platformOrderId: String(payload.id),
        topic,
        shopDomain: domain,
      },
    });
    try {
      // The REST payload has no structured variant options, so re-fetch the order
      // over GraphQL to resolve figure count through the same path as the sync.
      // Falls back to the REST payload (→ unresolved / review queue) if that fails.
      const fallbackOrder = normalizeWebhookOrder(payload);
      let order = fallbackOrder;
      let resolution: "graphql" | "rest_fallback" = "rest_fallback";
      if (isShopifyConnected(found.creds)) {
        const client = new ShopifyClient(ctx.id, found.creds);
        const resolved = await resolveWebhookOrder(client, fallbackOrder);
        order = resolved.order;
        resolution = resolved.resolution;
        if (resolved.error) {
          console.log(
            JSON.stringify({
              ts: new Date().toISOString(),
              level: "warn",
              integration: "shopify",
              shopId: ctx.id,
              event: "webhook_graphql_refetch_failed",
              platformOrderId: String(payload.id),
              error: resolved.error,
            }),
          );
        }
      }

      const result = await importShopifyOrder({ shop: ctx, order, via: "webhook" });
      // Auto-send the photo request in near-real-time for a webhook import.
      let flushError: string | null = null;
      if (result === "imported") {
        await flushQueued(ctx.businessId).catch((error) => {
          flushError = error instanceof Error ? error.message : String(error);
        });
      }
      const partial = resolution === "rest_fallback" || !!flushError;
      await finishJobRun(runId, {
        status: partial ? "partial" : "ok",
        itemsProcessed: 1,
        itemsFailed: partial ? 1 : 0,
        metadata: {
          platformOrderId: String(payload.id),
          topic,
          shopDomain: domain,
          resolution,
          result,
          flushError,
        },
      });
      console.log(
        JSON.stringify({
          ts: new Date().toISOString(),
          integration: "shopify",
          shopId: ctx.id,
          event: "webhook_processed",
          platformOrderId: String(payload.id),
          resolution,
          result,
        }),
      );
    } catch (err) {
      await failJobRun(runId, err, {
        platformOrderId: String(payload.id),
        topic,
        shopDomain: domain,
      });
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
