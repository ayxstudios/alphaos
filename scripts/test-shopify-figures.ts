/**
 * Proves the Shopify WEBHOOK path resolves figure count as reliably as the sync.
 *
 * The orders/create REST payload carries figure count only inside the joined
 * `variant_title` string ("2 Figures / A3 Print") with no option names, so a
 * name-based figure rule cannot match it directly. The webhook re-fetches the
 * order over GraphQL (resolveWebhookOrder) to get structured selectedOptions and
 * resolves through the SAME shared resolver as the sync.
 *
 * Stubs the GraphQL client so the figure part runs offline.
 *
 * Also proves digital vs physical (admin QA round 2: PixArt's "Print On:
 * Digital File Only" variant keeps requiresShipping = true and imported as
 * Physical): pure cases for Shopify and Etsy, then on the database an import
 * of a physical, a digital and a conflicting order, and a re-resolve healing an
 * order imported by the old rule.
 */
import "./load-env";

import { randomUUID } from "node:crypto";
import { Pool, neonConfig } from "@neondatabase/serverless";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-serverless";
import ws from "ws";

import { withSystemContext, type RequestUser } from "../lib/db";
import * as schema from "../lib/db/schema";
import { activityLog, businesses, customers, orderItems, orders, shops, users } from "../lib/db/schema";
import {
  importShopifyOrder,
  lineProductType,
  normalizeGraphqlOrder,
  normalizeWebhookOrder,
  resolveWebhookOrder,
  resolveFigureCount,
  resolverInput,
  type GraphqlRunner,
  type NormalizedOrder,
  type ShopContext,
  type ShopifyWebhookOrder,
} from "../lib/integrations/shopify";
import { resolveProductType, type FigureConfig } from "../lib/integrations/figures";
import { parseEtsyReceiptReview } from "../lib/integrations/etsy/receipt-review";
import { reresolveShop } from "../lib/orders/resolution";
import type { GqlOrder } from "../lib/integrations/shopify/types";

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

  productTypeCases();
  await productTypeOnDatabase();

  console.log(`\n${failures === 0 ? "ALL PASSED" : failures + " FAILED"}`);
  process.exit(failures === 0 ? 0 : 1);
}

/* --- digital vs physical ------------------------------------------------ */

const WITHIN_72 = "Need Your Order Within 72 Hours? (For Digital Portraits or Approvals *NOT SHIPPING TIME*)";

/** A PixArt line exactly as the Admin API returns it (field shapes from staging). */
function pixartLine(printOn: string, requiresShipping: boolean, extra: { key: string; value: string }[] = []) {
  return {
    sku: "PET-PORTRAIT",
    title: "Custom Pet Portrait",
    variantTitle: `1 / ${printOn} / No Thanks`,
    quantity: 1,
    requiresShipping,
    variant: {
      selectedOptions: [
        { name: "Number of Pets:", value: "1" },
        { name: "Print On:", value: printOn },
        { name: WITHIN_72, value: "No Thanks" },
      ],
    },
    customAttributes: [
      { key: "Background", value: "Pink" },
      { key: "Pet Name(s)", value: "Winkie" },
      { key: "Uploaded photo", value: "https://cdn.example.com/winkie.jpg" },
      ...extra,
    ],
  };
}

function pixartOrder(id: string, line: ReturnType<typeof pixartLine>): GqlOrder {
  return {
    id: `gid://shopify/Order/${id}`,
    name: `PT${id}`,
    sourceName: "web",
    legacyResourceId: id,
    createdAt: new Date().toISOString(),
    displayFulfillmentStatus: "UNFULFILLED",
    cancelledAt: null,
    email: `buyer-${id}@example.com`,
    customer: { firstName: "Pat", lastName: "Buyer", email: `buyer-${id}@example.com` },
    shippingAddress: null,
    lineItems: { nodes: [line] },
  } as unknown as GqlOrder;
}

function productTypeCases() {
  console.log("\n=== digital vs physical: Shopify lines ===");
  const cases: { name: string; line: ReturnType<typeof pixartLine>; type: string; conflict: boolean }[] = [
    { name: "Digital File Only on a shipping variant -> digital", line: pixartLine("Digital File Only", true), type: "digital", conflict: false },
    { name: "Canvas on a shipping variant -> physical", line: pixartLine('Canvas 8"X10" / 20X25cm', true), type: "physical", conflict: false },
    { name: "Black Frame -> physical (the 72h option NAME says Digital, ignored)", line: pixartLine('Black Frame 8"X12" / 20X30cm', true), type: "physical", conflict: false },
    { name: "no shipping, neutral options -> digital", line: pixartLine("Standard", false), type: "digital", conflict: false },
    { name: "Canvas + Digital File in one value -> conflict", line: pixartLine("Canvas + Digital File", true), type: "physical", conflict: true },
    { name: "no shipping but Poster Print -> conflict", line: pixartLine('Poster Print 8"X10" / 20X25cm', false), type: "digital", conflict: true },
    {
      name: "customer note mentioning digital does not move a canvas",
      line: pixartLine('Canvas 16"X20" / 40X50cm', true, [{ key: "Notes", value: "please send the digital file too" }]),
      type: "physical",
      conflict: false,
    },
  ];
  for (const c of cases) {
    const li = normalizeGraphqlOrder(pixartOrder("1", c.line)).lineItems[0];
    const kind = lineProductType(li);
    report(c.name, kind.productType === c.type && kind.conflict === c.conflict, `type=${kind.productType} source=${kind.source} note=${kind.note}`);
  }

  // Webhook REST fallback: no selectedOptions, only the joined variant title.
  const rest = normalizeWebhookOrder({
    ...payload,
    line_items: [{ ...payload.line_items[0], variant_title: "1 / Digital File Only / No Thanks", requires_shipping: true }],
  });
  const restKind = lineProductType(rest.lineItems[0]);
  report("REST webhook: variant title Digital File Only -> digital", restKind.productType === "digital" && !restKind.conflict, restKind.note);

  console.log("\n=== digital vs physical: Etsy receipts ===");
  const receipt = (isDigital: boolean, printOn: string) => ({
    receipt_id: 1,
    transactions: [
      {
        transaction_id: 2,
        title: "Custom Pet Portrait",
        quantity: 1,
        is_digital: isDigital,
        variations: [
          { formatted_name: "Print On:", formatted_value: printOn },
          { formatted_name: "Personalization", formatted_value: "a print for mum, digital copy for me" },
        ],
      },
    ],
  });
  const etsyDownload = parseEtsyReceiptReview(receipt(true, "Standard"));
  report("Etsy is_digital listing -> digital", etsyDownload.inferredFulfillment === "digital", JSON.stringify(etsyDownload.transactions[0].fulfillment));
  const etsyOption = parseEtsyReceiptReview(receipt(false, "Digital File Only"));
  report("Etsy Digital File Only option -> digital", etsyOption.inferredFulfillment === "digital", JSON.stringify(etsyOption.transactions[0].fulfillment));
  const etsyPrint = parseEtsyReceiptReview(receipt(false, "Canvas 8&quot;X10&quot;"));
  report("Etsy Canvas option -> physical", etsyPrint.inferredFulfillment === "physical", JSON.stringify(etsyPrint.transactions[0].fulfillment));
  const etsyConflict = parseEtsyReceiptReview(receipt(true, "Canvas 8&quot;X10&quot;"));
  report(
    "Etsy download listing with a Canvas option -> conflict, no guess",
    etsyConflict.inferredFulfillment === null && etsyConflict.transactions[0].fulfillmentConflict,
    JSON.stringify({ inferred: etsyConflict.inferredFulfillment, conflict: etsyConflict.transactions[0].fulfillmentConflict }),
  );
  report(
    "resolver never reads option names",
    resolveProductType([{ name: "Digital upgrade", value: "No Thanks" }], false).productType === "physical",
    "name-only mention of digital stays physical",
  );
}

async function productTypeOnDatabase() {
  console.log("\n=== digital vs physical: import + re-resolve on the database ===");
  const ids = { businessId: randomUUID(), shopId: randomUUID(), adminId: randomUUID() };
  const stamp = Date.now();
  await withSystemContext(async (tx) => {
    await tx.insert(businesses).values({ id: ids.businessId, name: "Product Type Test", slug: `ptype-${stamp}` });
    await tx.insert(shops).values({
      id: ids.shopId,
      businessId: ids.businessId,
      platform: "shopify",
      name: "Product Type Shop",
      externalShopId: `ptype-${stamp}.myshopify.com`,
      credentials: {},
      integrationConfig: {},
    });
    await tx.insert(users).values({ id: ids.adminId, email: `ptype-admin-${stamp}@example.com`, name: "Type Admin", role: "admin" });
  });
  const ctx: ShopContext = { id: ids.shopId, businessId: ids.businessId, slaConfig: null, config: {}, suppressCustomerEmail: true };
  const imp = (id: string, line: ReturnType<typeof pixartLine>) =>
    importShopifyOrder({ shop: ctx, order: normalizeGraphqlOrder(pixartOrder(id, line)) as NormalizedOrder, via: "sync" });
  const read = (id: string) =>
    withSystemContext(async (tx) => {
      const [o] = await tx
        .select({ id: orders.id, needsReview: orders.needsReview })
        .from(orders)
        .where(eq(orders.platformOrderId, id));
      const items = await tx.select({ productType: orderItems.productType }).from(orderItems).where(eq(orderItems.orderId, o.id));
      return { id: o.id, needsReview: o.needsReview, types: items.map((i) => i.productType) };
    });

  try {
    const pid = `${stamp}`;
    await imp(`${pid}1`, pixartLine('Canvas 8"X10" / 20X25cm', true));
    await imp(`${pid}2`, pixartLine("Digital File Only", true));
    await imp(`${pid}3`, pixartLine("Canvas + Digital File", true));
    const physical = await read(`${pid}1`);
    const digital = await read(`${pid}2`);
    const conflict = await read(`${pid}3`);
    report("import: Canvas -> physical, no review", physical.types.join() === "physical" && !physical.needsReview, JSON.stringify(physical));
    report("import: Digital File Only -> digital, no review", digital.types.join() === "digital" && !digital.needsReview, JSON.stringify(digital));
    report("import: conflicting options -> needs review", conflict.needsReview, JSON.stringify(conflict));

    // An order imported by the old rule (requiresShipping only) reads Physical;
    // the offline re-resolve (shop not connected) heals it from raw_variations.
    await withSystemContext((tx) =>
      tx.update(orderItems).set({ productType: "physical" }).where(eq(orderItems.orderId, digital.id)),
    );
    const admin: RequestUser = { id: ids.adminId, role: "admin" };
    const summary = await reresolveShop(admin, ids.shopId);
    const healed = await read(`${pid}2`);
    const stillPhysical = await read(`${pid}1`);
    const stillConflict = await read(`${pid}3`);
    report(
      "re-resolve heals the old Physical import to digital",
      healed.types.join() === "digital" && summary.productTypesFixed === 1,
      JSON.stringify({ healed, fixed: summary.productTypesFixed }),
    );
    report("re-resolve leaves the physical order physical", stillPhysical.types.join() === "physical", JSON.stringify(stillPhysical));
    report(
      "re-resolve keeps the conflict in review",
      stillConflict.needsReview && summary.productTypeConflicts === 1,
      JSON.stringify({ stillConflict, conflicts: summary.productTypeConflicts }),
    );
  } finally {
    // activity_log is append-only for app_user: clean up on the owner connection.
    neonConfig.webSocketConstructor = ws;
    const pool = new Pool({ connectionString: process.env.DIRECT_URL ?? process.env.DATABASE_URL! });
    try {
      await drizzle(pool, { schema }).transaction(async (tx) => {
        await tx.delete(activityLog).where(eq(activityLog.businessId, ids.businessId));
        await tx.delete(orders).where(eq(orders.shopId, ids.shopId));
        await tx.delete(customers).where(eq(customers.businessId, ids.businessId));
        await tx.delete(shops).where(eq(shops.id, ids.shopId));
        await tx.delete(users).where(eq(users.id, ids.adminId));
        await tx.delete(businesses).where(eq(businesses.id, ids.businessId));
      });
    } finally {
      await pool.end();
    }
  }
}

main().catch((e) => {
  console.error("test-shopify-figures crashed:", e);
  process.exit(1);
});
