/**
 * Backfill cutoff invariant: platform orders placed before a shop cutoff import
 * as archived history, while newer orders import as live work.
 */
import "./load-env";

import { randomUUID } from "node:crypto";
import { Pool, neonConfig } from "@neondatabase/serverless";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-serverless";
import ws from "ws";

import { withSystemContext } from "../lib/db";
import * as schema from "../lib/db/schema";
import {
  activityLog,
  assets,
  businesses,
  customers,
  orderItems,
  orders,
  shops,
} from "../lib/db/schema";
import { importShopifyOrder, type NormalizedOrder, type ShopContext } from "../lib/integrations/shopify";

let failures = 0;
const ids = {
  businessId: randomUUID(),
  shopId: randomUUID(),
};

function report(name: string, pass: boolean, detail: string) {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
  console.log(`      ${detail}`);
  if (!pass) failures += 1;
}

function order(platformOrderId: string, createdAt: Date): NormalizedOrder {
  return {
    platformOrderId,
    orderName: platformOrderId,
    sourceName: "web",
    createdAt,
    email: `${platformOrderId.toLowerCase()}@example.com`,
    firstName: "Backfill",
    lastName: "Buyer",
    lineItems: [
      {
        sku: "PORTRAIT",
        title: "Custom Hand-Drawn Cartoon Pet Portrait",
        variantTitle: "1 Figure",
        digital: true,
        quantity: 1,
        hasVariant: true,
        selectedOptions: [{ name: "Number of Pets", value: "1" }],
        properties: [],
        photoUrls: ["https://cdn.example.com/reference.jpg"],
      },
    ],
  };
}

async function setup() {
  await withSystemContext(async (tx) => {
    await tx.insert(businesses).values({ id: ids.businessId, name: "Backfill Archive Test", slug: `backfill-${Date.now()}` });
    await tx.insert(shops).values({
      id: ids.shopId,
      businessId: ids.businessId,
      platform: "shopify",
      name: "Backfill Test Shop",
      externalShopId: `backfill-${Date.now()}.myshopify.com`,
      credentials: {},
      integrationConfig: {
        backfillCutoffAt: "2026-08-12T00:00:00.000Z",
        lastSyncAt: new Date().toISOString(),
      },
    });
  });
}

async function cleanup() {
  neonConfig.webSocketConstructor = ws;
  const pool = new Pool({ connectionString: process.env.DIRECT_URL ?? process.env.DATABASE_URL! });
  const ownerDb = drizzle(pool, { schema });
  try {
    await ownerDb.transaction(async (tx) => {
      const orderRows = await tx.select({ id: orders.id }).from(orders).where(eq(orders.shopId, ids.shopId));
      const orderIds = orderRows.map((row) => row.id);
      if (orderIds.length) {
        await tx.delete(assets).where(inArray(assets.orderId, orderIds));
        await tx.delete(orderItems).where(inArray(orderItems.orderId, orderIds));
        await tx.delete(activityLog).where(inArray(activityLog.orderId, orderIds));
        await tx.delete(orders).where(inArray(orders.id, orderIds));
      }
      await tx.delete(customers).where(eq(customers.businessId, ids.businessId));
      await tx.delete(shops).where(eq(shops.id, ids.shopId));
      await tx.delete(businesses).where(eq(businesses.id, ids.businessId));
    });
  } finally {
    await pool.end();
  }
}

async function main() {
  try {
    await setup();
    const ctx: ShopContext = {
      id: ids.shopId,
      businessId: ids.businessId,
      slaConfig: null,
      config: { backfillCutoffAt: "2026-08-12T00:00:00.000Z" },
      suppressCustomerEmail: false,
    };

    const oldResult = await importShopifyOrder({
      shop: ctx,
      order: order("OLD-BACKFILL", new Date("2026-08-11T23:59:59.000Z")),
      via: "backfill",
    });
    const liveResult = await importShopifyOrder({
      shop: ctx,
      order: order("LIVE-BACKFILL", new Date("2026-08-12T00:00:00.000Z")),
      via: "backfill",
    });

    const rows = await withSystemContext((tx) =>
      tx
        .select({
          platformOrderId: orders.platformOrderId,
          archivedAt: orders.archivedAt,
          archiveReason: orders.archiveReason,
        })
        .from(orders)
        .where(and(eq(orders.shopId, ids.shopId), inArray(orders.platformOrderId, ["OLD-BACKFILL", "LIVE-BACKFILL"]))),
    );
    const oldRow = rows.find((row) => row.platformOrderId === "OLD-BACKFILL");
    const liveRow = rows.find((row) => row.platformOrderId === "LIVE-BACKFILL");

    report("old order imports as archived", oldResult === "archived" && !!oldRow?.archivedAt, JSON.stringify({ oldResult, oldRow }));
    report("cutoff boundary imports as live", liveResult === "imported" && liveRow?.archivedAt == null, JSON.stringify({ liveResult, liveRow }));
    report("archived order records an audit reason", oldRow?.archiveReason === "Imported before shop backfill cutoff", oldRow?.archiveReason ?? "none");
  } finally {
    await cleanup();
  }

  console.log(`\n${failures === 0 ? "ALL PASSED" : failures + " FAILED"}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error("test-backfill-archive crashed:", error);
  await cleanup().catch(() => undefined);
  process.exit(1);
});
