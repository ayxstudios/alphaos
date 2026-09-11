/**
 * Wire a business's print provider for RECONCILIATION ONLY (2026-09-12).
 *
 * AlphaOS never submits print orders to a provider (the Gelato and Luma
 * Prints clients only read: getOrder / findByReference, see
 * lib/print/reconcile.ts). Saving an API key here therefore turns on
 * missed-order detection and shipment tracking for that business and
 * nothing else. One product mapping is written too so the print queue has a
 * reference product; mappings are consulted only if order submission is
 * ever built.
 *
 * Usage:
 *   npx tsx scripts/print-reconcile-only.ts <business-slug> [--product-uid <gelato uid>] [--title-contains <text>]
 * The Gelato key is read from GELATO_API_KEY in the environment (never from
 * argv). Runs on the OWNER connection (DIRECT_URL). Idempotent.
 */
import "./load-env";

import { and, eq } from "drizzle-orm";
import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import ws from "ws";

import * as schema from "../lib/db/schema";
import { getBusinessPrintCredentials, setBusinessPrintCredentials } from "../lib/db/credentials";
import { GelatoClient } from "../lib/integrations/gelato";

neonConfig.webSocketConstructor = ws;

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  const slug = process.argv[2];
  if (!slug || slug.startsWith("--")) throw new Error("business slug required");
  const apiKey = process.env.GELATO_API_KEY?.trim();
  if (!apiKey) throw new Error("GELATO_API_KEY is not set in the environment");
  const url = process.env.DIRECT_URL;
  if (!url || new URL(url).username !== "neondb_owner") throw new Error("DIRECT_URL (owner connection) required");
  const productUid = arg("--product-uid", "canvas_12x16-inch-300x400-mm_canvas_wood-fsc-slim_4-0_ver");
  const titleContains = arg("--title-contains", "canvas");

  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool, { schema });

  // The key must be a real Gelato key: one read call before anything is saved.
  const probe = await new GelatoClient({ apiKey }).findByReference("alphaos-probe-never-matches", {
    since: new Date(Date.now() - 24 * 3600 * 1000),
  });
  if (probe !== null) throw new Error("probe unexpectedly matched an order");

  await db.transaction(async (tx) => {
    const [biz] = await tx.select({ id: schema.businesses.id, name: schema.businesses.name }).from(schema.businesses).where(eq(schema.businesses.slug, slug)).limit(1);
    if (!biz) throw new Error(`no business with slug ${slug}`);
    const [shop] = await tx
      .select({ id: schema.shops.id, name: schema.shops.name })
      .from(schema.shops)
      .where(eq(schema.shops.businessId, biz.id))
      .limit(1);
    if (!shop) throw new Error(`business ${slug} has no shop`);

    const current = ((await getBusinessPrintCredentials(tx, biz.id)) as Record<string, unknown> | null) ?? {};
    await setBusinessPrintCredentials(tx, biz.id, { ...current, gelato: { apiKey, webhookSecret: null } });

    const [existing] = await tx
      .select({ id: schema.printProductMappings.id })
      .from(schema.printProductMappings)
      .where(and(eq(schema.printProductMappings.businessId, biz.id), eq(schema.printProductMappings.provider, "gelato"), eq(schema.printProductMappings.providerProductId, productUid)))
      .limit(1);
    const values = {
      businessId: biz.id,
      shopId: shop.id,
      provider: "gelato" as const,
      matchType: "title_variant_contains",
      sourceSku: null,
      titleContains,
      variantContains: null,
      label: `Canvas 12x16 (reconcile only)`,
      providerProductId: productUid,
      providerConfig: { reconcileOnly: true, note: "Reference product for reconciliation; AlphaOS submits no print orders." },
      active: true,
      updatedAt: new Date(),
    };
    if (existing) await tx.update(schema.printProductMappings).set(values).where(eq(schema.printProductMappings.id, existing.id));
    else await tx.insert(schema.printProductMappings).values(values);

    console.log(`ok: ${biz.name} gelato key saved (reconcile only), mapping ${existing ? "updated" : "created"} on ${shop.name} -> ${productUid}`);
  });
  await pool.end();
}

main().catch((err) => {
  console.error("print-reconcile-only failed:", err?.message || err);
  process.exit(1);
});
