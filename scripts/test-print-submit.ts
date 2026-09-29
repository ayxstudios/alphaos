/**
 * One-tap print submit (docs/AGENT_FIRST.md 3.2) against the DEMO database with
 * PRINT_PROVIDER_MOCK=1 (no real provider is ever called):
 * - routing: default Lumaprints, a business override wins, a single-provider
 *   mapping wins regardless (pure chooseProvider checks);
 * - an approved physical demo order, given a mapping for both providers and a
 *   shipping address (inserts only, never truncates), prepares with no blockers;
 * - submit writes an "api" print job with the mock provider order id, moves the
 *   order to printing, logs print.submitted and drafts/queues the printing email;
 * - a second submit is refused;
 * - a digital-only order reports the digital_only blocker;
 * - a print_routing override to Gelato makes prepare pick Gelato;
 * - after submit, reconcile (mock order "ships" once PRINT_MOCK_SHIP_AFTER_SECONDS
 *   has passed; 0 here) moves the order to shipped with tracking.
 * Each run consumes one approved demo order (it ends shipped); rerun picks the next.
 *
 *   npx tsx scripts/test-print-submit.ts
 */
process.env.PRINT_PROVIDER_MOCK = "1";

import "./load-env";

import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { withSystemContext, type Tx } from "../lib/db";
import { getBusinessPrintCredentials, setBusinessPrintCredentials } from "../lib/db/credentials";
import {
  activityLog,
  assets,
  businesses,
  messages,
  orderShippingAddresses,
  orders,
  printJobs,
  printProductMappings,
  users,
} from "../lib/db/schema";
import { installMockTransport } from "../lib/mock/transport";
import { imageSizeFromHeader } from "../lib/print/file-probe";
import { preparePrintOrder } from "../lib/print/prepare";
import { reconcileOrderPrintJob } from "../lib/print/reconcile";
import { chooseProvider } from "../lib/print/routing";
import { submitPrintOrder } from "../lib/print/submit";
import { upsertOrderShippingAddress } from "../lib/shipping/address";

let failures = 0;
function report(name: string, pass: boolean, detail: string) {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
  console.log(`      ${detail}`);
  if (!pass) failures += 1;
}

const LUMA_CONFIG = {
  productType: "canvas",
  size: "8x10",
  subcategoryId: 101001,
  width: 8,
  height: 10,
  unitCost: 29.5,
  currency: "USD",
};
const GELATO_CONFIG = { productType: "canvas", size: "8x10" }; // no unitCost: "cost unavailable"

async function ensureMapping(tx: Tx, shopId: string, businessId: string, sku: string, provider: "lumaprints" | "gelato") {
  const [existing] = await tx
    .select({ id: printProductMappings.id })
    .from(printProductMappings)
    .where(
      and(
        eq(printProductMappings.shopId, shopId),
        eq(printProductMappings.provider, provider),
        eq(printProductMappings.sourceSku, sku),
        eq(printProductMappings.active, true),
      ),
    )
    .limit(1);
  if (existing) return existing.id;
  const [row] = await tx
    .insert(printProductMappings)
    .values({
      businessId,
      shopId,
      provider,
      matchType: "sku_exact",
      sourceSku: sku,
      label: provider === "lumaprints" ? "8x10 canvas, 0.75in wrap" : "8x10 canvas (Gelato)",
      providerProductId: provider === "lumaprints" ? "101001" : "canvas_8x10-inch_canvas_wood-fsc-slim_4-0_ver",
      providerConfig: provider === "lumaprints" ? LUMA_CONFIG : GELATO_CONFIG,
      active: true,
    })
    .returning({ id: printProductMappings.id });
  return row!.id;
}

async function main() {
  // Shopify fulfillment write-back during reconcile must hit the mock, never a real store.
  installMockTransport();
  // --- 1. Routing, pure -----------------------------------------------------
  const both = ["lumaprints", "gelato"] as const;
  const d1 = chooseProvider({ printRouting: {} }, { productType: "canvas", size: "8x10", mappedProviders: [...both] });
  report("routing: empty rule defaults to Lumaprints", d1.provider === "lumaprints" && d1.reason === "default", JSON.stringify(d1));
  const rule = { default: "lumaprints", overrides: [{ productType: "Canvas", size: "8 x 10", provider: "gelato" }] };
  const d2 = chooseProvider({ printRouting: rule }, { productType: "canvas", size: "8x10", mappedProviders: [...both] });
  report("routing: matching override picks Gelato", d2.provider === "gelato" && d2.reason === "override", JSON.stringify(d2));
  const d3 = chooseProvider({ printRouting: rule }, { productType: "canvas", size: "8x10", mappedProviders: ["lumaprints"] });
  report("routing: only-mapping beats the override", d3.provider === "lumaprints" && d3.reason === "only mapping", JSON.stringify(d3));
  const d4 = chooseProvider({ printRouting: rule }, { productType: "poster", size: "8x10", mappedProviders: [...both] });
  report("routing: non-matching override falls to default", d4.provider === "lumaprints" && d4.reason === "default", JSON.stringify(d4));

  // Print file resolution comes from the file header (assets store no dimensions).
  const png = Buffer.alloc(24);
  png.writeUInt32BE(0x89504e47, 0);
  png.write("IHDR", 12, "ascii");
  png.writeUInt32BE(4800, 16);
  png.writeUInt32BE(6000, 20);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x0b, 0xb8, 0x09, 0x60, 0x03]);
  const pngSize = imageSizeFromHeader(png);
  const jpegSize = imageSizeFromHeader(jpeg);
  report(
    "file probe: PNG and JPEG headers give width x height",
    pngSize?.width === 4800 && pngSize.height === 6000 && jpegSize?.width === 2400 && jpegSize.height === 3000,
    JSON.stringify({ pngSize, jpegSize }),
  );

  // --- 2. Pick and fix up an approved physical demo order --------------------
  const setup = await withSystemContext(async (tx) => {
    const candidates = await tx.execute(sql`
      select o.id, o.business_id, o.shop_id, o.platform_order_name, i.sku
      from orders o
      join order_items i on i.order_id = o.id and i.product_type = 'physical'
      where o.status = 'approved' and o.archived_at is null and i.sku is not null
        and exists (select 1 from assets a where a.order_id = o.id and a.type = 'final' and a.deleted_at is null)
        and not exists (select 1 from print_jobs j where j.order_id = o.id)
        and not exists (select 1 from order_items x where x.order_id = o.id and x.product_type = 'physical' and x.sku is distinct from i.sku)
      order by o.platform_order_name nulls last
      limit 2`);
    const rows = candidates.rows as Array<{ id: string; business_id: string; shop_id: string; platform_order_name: string | null; sku: string }>;
    if (!rows.length) return null;
    const [admin] = await tx.select({ id: users.id }).from(users).where(eq(users.role, "admin")).limit(1);

    for (const row of rows) {
      await ensureMapping(tx, row.shop_id, row.business_id, row.sku, "lumaprints");
      await ensureMapping(tx, row.shop_id, row.business_id, row.sku, "gelato");
      const [addr] = await tx
        .select({ id: orderShippingAddresses.id })
        .from(orderShippingAddresses)
        .where(eq(orderShippingAddresses.orderId, row.id))
        .limit(1);
      if (!addr) {
        await upsertOrderShippingAddress(tx, {
          businessId: row.business_id,
          orderId: row.id,
          source: "manual",
          address: {
            name: "Jordan Demo",
            addressLine1: "500 Market Street",
            addressLine2: "Apt 4",
            city: "Portland",
            state: "OR",
            postalCode: "97201",
            countryCode: "US",
            email: "jordan.demo@example.com",
          },
        });
      }
    }

    // Mock credentials only where a provider has none (existing ones are kept).
    const current = ((await getBusinessPrintCredentials(tx, rows[0].business_id)) ?? {}) as Record<string, unknown>;
    const merged = { ...current };
    if (!(current.lumaprints as { username?: string } | undefined)?.username) {
      merged.lumaprints = { username: "mock_demo_luma", password: "mock_demo_luma", storeId: "818" };
    }
    if (!(current.gelato as { apiKey?: string } | undefined)?.apiKey) {
      merged.gelato = { apiKey: "mock_demo_gelato", webhookSecret: "mock_demo_gelato_webhook" };
    }
    if (merged.lumaprints !== current.lumaprints || merged.gelato !== current.gelato) {
      await setBusinessPrintCredentials(tx, rows[0].business_id, merged);
    }
    return { orders: rows, adminId: admin?.id ?? null };
  });

  if (!setup || !setup.adminId) {
    report("setup: approved physical demo order with a final file", false, "none left without a print job (each run consumes one)");
    process.exit(1);
  }
  const target = setup.orders[0];
  const adminId = setup.adminId;
  console.log(`      using order ${target.platform_order_name ?? target.id} (${target.id}), sku ${target.sku}`);

  // --- 3. Prepare ------------------------------------------------------------
  const plan = await preparePrintOrder(target.id);
  report(
    "prepare: approved physical order has no blockers",
    !!plan && plan.blockers.length === 0,
    plan ? `blockers=${JSON.stringify(plan.blockers)}` : "no plan",
  );
  report(
    "prepare: file, mapping, cost, address resolved",
    !!plan &&
      plan.file?.source === "final_asset" &&
      plan.provider === "lumaprints" &&
      plan.routingReason === "default" &&
      plan.items[0]?.providerSku === "101001" &&
      plan.items[0]?.size === "8x10" &&
      plan.totalCost === 29.5 &&
      plan.availableProviders.length === 2 &&
      !!plan.address?.addressLine1,
    plan
      ? `file=${plan.file?.name} provider=${plan.provider}/${plan.routingReason} sku=${plan.items[0]?.providerSku} size=${plan.items[0]?.size} cost=${plan.totalCost} ${plan.currency} providers=${plan.availableProviders.join(",")}`
      : "",
  );
  const gelatoOption = plan?.items[0]?.options.find((o) => o.provider === "gelato");
  report(
    "prepare: Gelato option reports cost unavailable with a reason",
    !!gelatoOption && gelatoOption.unitCost === null && !!gelatoOption.costReason,
    `gelato costReason=${gelatoOption?.costReason}`,
  );

  // --- 4. Submit -------------------------------------------------------------
  const first = await submitPrintOrder({ orderId: target.id, actorUserId: adminId, actorRole: "admin" });
  report("submit: accepted", first.ok, first.message);

  const after = await withSystemContext(async (tx) => {
    const [job] = await tx
      .select()
      .from(printJobs)
      .where(eq(printJobs.orderId, target.id))
      .orderBy(desc(printJobs.createdAt))
      .limit(1);
    const [order] = await tx.select({ status: orders.status }).from(orders).where(eq(orders.id, target.id));
    const acts = await tx
      .select({ action: activityLog.action, metadata: activityLog.metadata })
      .from(activityLog)
      .where(and(eq(activityLog.orderId, target.id), inArray(activityLog.action, ["print.submitted", "order.printing"])));
    const emails = await tx
      .select({ id: messages.id, status: messages.status })
      .from(messages)
      .where(and(eq(messages.orderId, target.id), eq(messages.templateKey, "printing")));
    return { job, status: order?.status, acts, emails };
  });
  report(
    "submit: api print job with the mock provider order id",
    after.job?.method === "api" &&
      after.job.provider === "lumaprints" &&
      /^9\d{10}$/.test(after.job.providerOrderId ?? "") &&
      after.job.status === "sent_to_print" &&
      !!after.job.submittedAt,
    `job method=${after.job?.method} provider=${after.job?.provider} providerOrderId=${after.job?.providerOrderId} number=${after.job?.providerOrderNumber} status=${after.job?.status} providerStatus=${after.job?.providerStatus}`,
  );
  report("submit: order is printing", after.status === "printing", `status=${after.status}`);
  const submittedAct = after.acts.find((a) => a.action === "print.submitted");
  report(
    "submit: print.submitted activity with provider, id, cost",
    !!submittedAct && (submittedAct.metadata as Record<string, unknown>).providerOrderId === after.job?.providerOrderId,
    `metadata=${JSON.stringify(submittedAct?.metadata)}`,
  );
  report(
    "submit: printing email drafted/queued exactly once",
    after.emails.length === 1 && first.ok && first.printingEmailId === after.emails[0].id,
    `emails=${JSON.stringify(after.emails)}`,
  );

  // --- 5. Second submit refused ---------------------------------------------
  const second = await submitPrintOrder({ orderId: target.id, actorUserId: adminId, actorRole: "admin" });
  const jobCount = await withSystemContext(async (tx) =>
    (await tx.select({ id: printJobs.id }).from(printJobs).where(eq(printJobs.orderId, target.id))).length,
  );
  report("submit: second submit refused, no second job", !second.ok && jobCount === 1, `${second.message} (jobs=${jobCount})`);

  // --- 6. Digital-only order -------------------------------------------------
  const digitalId = await withSystemContext(async (tx) => {
    const r = await tx.execute(sql`
      select o.id from orders o
      where exists (select 1 from order_items i where i.order_id = o.id)
        and not exists (select 1 from order_items i where i.order_id = o.id and i.product_type = 'physical')
      order by (o.status = 'approved') desc
      limit 1`);
    return (r.rows[0] as { id: string } | undefined)?.id ?? null;
  });
  const digitalPlan = digitalId ? await preparePrintOrder(digitalId) : null;
  report(
    "prepare: digital-only order reports the blocker",
    !!digitalPlan && digitalPlan.blockers.some((b) => b.code === "digital_only"),
    `order=${digitalId} blockers=${JSON.stringify(digitalPlan?.blockers.map((b) => b.code))}`,
  );

  // --- 7. Routing override to Gelato on the business -------------------------
  const other = setup.orders[1] ?? null;
  const overrideTarget = other?.id ?? target.id;
  const overrideBusiness = other?.business_id ?? target.business_id;
  const previousRouting = await withSystemContext(async (tx) => {
    const [biz] = await tx.select({ r: businesses.printRouting }).from(businesses).where(eq(businesses.id, overrideBusiness));
    await tx
      .update(businesses)
      .set({ printRouting: { default: "lumaprints", overrides: [{ productType: "canvas", size: "8x10", provider: "gelato" }] } })
      .where(eq(businesses.id, overrideBusiness));
    return biz?.r ?? {};
  });
  try {
    const overridePlan = await preparePrintOrder(overrideTarget);
    report(
      "prepare: print_routing override picks Gelato",
      overridePlan?.provider === "gelato" && overridePlan.routingReason === "override" && overridePlan.items[0]?.unitCost === null,
      `order=${overrideTarget} provider=${overridePlan?.provider} reason=${overridePlan?.routingReason} cost=${overridePlan?.totalCost ?? "unavailable"}`,
    );
  } finally {
    await withSystemContext((tx) =>
      tx.update(businesses).set({ printRouting: previousRouting }).where(eq(businesses.id, overrideBusiness)),
    );
  }

  // --- 8. After submission: reconcile moves it to shipped ---------------------
  process.env.PRINT_MOCK_SHIP_AFTER_SECONDS = "0";
  const rec = await withSystemContext((tx) => reconcileOrderPrintJob(tx, target.business_id, target.id, "cron"));
  const shipped = await withSystemContext(async (tx) => {
    const [order] = await tx.select({ status: orders.status }).from(orders).where(eq(orders.id, target.id));
    const [job] = await tx
      .select({ trackingNumber: printJobs.trackingNumber, reconcileState: printJobs.reconcileState, number: printJobs.providerOrderNumber })
      .from(printJobs)
      .where(eq(printJobs.orderId, target.id))
      .orderBy(desc(printJobs.createdAt))
      .limit(1);
    const emails = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.orderId, target.id), eq(messages.templateKey, "shipped")));
    return { status: order?.status, job, shippedEmails: emails.length };
  });
  report(
    "after submit: reconcile ships the mock api job with tracking",
    rec?.outcome === "shipped" && shipped.status === "shipped" && !!shipped.job?.trackingNumber,
    `reconcile=${rec?.outcome} status=${shipped.status} tracking=${shipped.job?.trackingNumber} state=${shipped.job?.reconcileState} providerOrderNumber=${shipped.job?.number} shippedEmails=${shipped.shippedEmails}`,
  );

  // Asset sanity for the report: which file went to the provider.
  const [asset] = await withSystemContext((tx) =>
    tx.select({ url: assets.url }).from(assets).where(eq(assets.id, plan?.file?.assetId ?? "")).limit(1),
  );
  console.log(`      print file sent: ${asset?.url ?? "(none)"}`);

  console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
