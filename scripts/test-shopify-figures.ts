/**
 * Proves the Shopify WEBHOOK path resolves figure count as reliably as the sync.
 *
 * The orders/create REST payload carries figure count only inside the joined
 * `variant_title` string ("2 Figures / A3 Print") with no option names, so a
 * name-based figure rule cannot match it directly. The webhook re-fetches the
 * order over GraphQL (resolveWebhookOrder) to get structured selectedOptions and
 * resolves through the SAME shared resolver as the sync.
 *
 * Pure test — no DB. Stubs the GraphQL client so it runs offline.
 */
import "./load-env";

import {
  normalizeWebhookOrder,
  resolveWebhookOrder,
  resolveFigureCount,
  resolverInput,
  type GraphqlRunner,
  type ShopifyWebhookOrder,
} from "../lib/integrations/shopify";
import type { FigureConfig } from "../lib/integrations/figures";

let failures = 0;
function report(name: string, pass: boolean, detail: string) {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
  console.log(`      ${detail}`);
  if (!pass) failures += 1;
}

// A realistic orders/create webhook payload. Figure count lives ONLY in the
// joined variant_title; the product title and a customer-photo property are
// present exactly as Shopify sends them.
const payload: ShopifyWebhookOrder = {
  id: 5123456789,
  name: "PC12345",
  source_name: "web",
  created_at: "2026-08-03T10:15:00-04:00",
  email: "buyer@example.com",
  customer: { first_name: "Jamie", last_name: "Lee", email: "buyer@example.com" },
  line_items: [
    {
      sku: "PET-PORTRAIT",
      title: "Custom Pet Portrait",
      variant_title: "2 Figures / A3 Print",
      variant_id: 45130071572753,
      quantity: 1,
      requires_shipping: true,
      properties: [{ name: "Uploaded photo", value: "https://cdn.example.com/photo1.jpg" }],
    },
  ],
};

// The shop encodes figure count as a VARIANT OPTION named "Figures".
const shopConfig: FigureConfig = {
  figureRules: [{ match: "figures", type: "integer" }],
  allowHeuristicFigureCount: false,
};

// GraphQL follow-up returns the structured order with proper selectedOptions —
// exactly what the Admin API gives the sync for the same order.
const structuredClient: GraphqlRunner = {
  async graphql<T>(): Promise<T> {
    return {
      order: {
        id: "gid://shopify/Order/5123456789",
        name: "PC12345",
        legacyResourceId: "5123456789",
        createdAt: payload.created_at,
        email: payload.email,
        customer: { firstName: "Jamie", lastName: "Lee", email: payload.email },
        lineItems: {
          nodes: [
            {
              sku: "PET-PORTRAIT",
              title: "Custom Pet Portrait",
              variantTitle: "2 Figures / A3 Print",
              quantity: 1,
              requiresShipping: true,
              variant: {
                selectedOptions: [
                  { name: "Figures", value: "2 Figures" },
                  { name: "Print Size", value: "A3 Print" },
                ],
              },
              customAttributes: [{ key: "Uploaded photo", value: "https://cdn.example.com/photo1.jpg" }],
            },
          ],
        },
      },
    } as T;
  },
};

// A follow-up that fails (throttle / transient / token issue).
const failingClient: GraphqlRunner = {
  async graphql<T>(): Promise<T> {
    throw new Error("simulated GraphQL failure (429 throttled)");
  },
};

async function main() {
  const fallback = normalizeWebhookOrder(payload);

  console.log("=== primary path: GraphQL follow-up resolves figure_count = 2 ===");
  const primary = await resolveWebhookOrder(structuredClient, fallback);
  report(
    "resolution uses graphql",
    primary.resolution === "graphql",
    `resolution=${primary.resolution}${primary.error ? ` error=${primary.error}` : ""}`,
  );

  const selectedOptions = primary.order.lineItems[0].selectedOptions;
  report(
    "selectedOptions normalised to {name,value}",
    selectedOptions.some((o) => o.name === "Figures" && o.value === "2 Figures"),
    `selectedOptions=${JSON.stringify(selectedOptions)}`,
  );
  report(
    "order number captured from Shopify `name`",
    primary.order.orderName === "PC12345",
    `orderName=${primary.order.orderName}`,
  );

  const input = resolverInput(primary.order.lineItems[0]);
  const fig = resolveFigureCount(input, shopConfig);
  report(
    "integer rule against variant option -> figure_count = 2",
    fig.count === 2 && fig.source === "shop_rule",
    `count=${fig.count} source=${fig.source} note="${fig.note}"`,
  );

  console.log("\n=== map rules also work against variant options ===");
  const mapCfg: FigureConfig = {
    figureRules: [{ match: "figures", type: "map", map: { "2 figures": 2 } }],
  };
  const figMap = resolveFigureCount(input, mapCfg);
  report(
    "map rule against variant option -> figure_count = 2",
    figMap.count === 2 && figMap.source === "shop_rule",
    `count=${figMap.count} source=${figMap.source}`,
  );

  console.log("\n=== fallback: follow-up fails -> unresolved, never a guess ===");
  const fb = await resolveWebhookOrder(failingClient, fallback);
  report(
    "resolution falls back to rest",
    fb.resolution === "rest_fallback",
    `resolution=${fb.resolution} error=${fb.error}`,
  );
  const figFb = resolveFigureCount(resolverInput(fb.order.lineItems[0]), shopConfig);
  report(
    "REST-only order lands unresolved (review queue), not guessed",
    figFb.count === null && figFb.source === "unresolved",
    `count=${figFb.count} source=${figFb.source} note="${figFb.note}"`,
  );
  // The order still imports (fallback order is a valid NormalizedOrder).
  report(
    "fallback still yields an importable order",
    fb.order.platformOrderId === "5123456789" && fb.order.lineItems.length === 1,
    `platformOrderId=${fb.order.platformOrderId} lineItems=${fb.order.lineItems.length}`,
  );

  console.log(`\n${failures === 0 ? "ALL PASSED" : failures + " FAILED"}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("test-shopify-figures crashed:", e);
  process.exit(1);
});
