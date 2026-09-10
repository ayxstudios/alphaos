/**
 * Go live on PixArt (2026-09-10): strip every mock row out of the PixArt
 * business, disarm the mock mailbox / print credentials so nothing fake can
 * act on real customers, then re-sync the real Etsy shop from a cutoff.
 *
 *   npx tsx scripts/go-live-pixart.ts            # dry run: counts only
 *   npx tsx scripts/go-live-pixart.ts --apply    # do it
 *
 * Idempotent. Real orders are recognised by their Etsy receipt id shape
 * (a real receipt id is ten digits starting with 4; mock ids are 3300000xxx,
 * manual:3300000xxx, HIST-* and ORD-*).
 * The demo business (Lumina) is untouched.
 */
import "./load-env";

import { sql } from "drizzle-orm";

import { withSystemContext } from "@/lib/db";
import { syncShopReceipts } from "@/lib/integrations/etsy";

const PIXART = "5e784759-93aa-40f9-a5f5-696ace0bc323";
const PIXART_ETSY = "8e46604a-6fef-4384-abdb-f07f17b37ca9";
const MOCK_ORDER = sql`not (platform_order_id ~ '^4[0-9]{9}$' and shop_id = ${PIXART_ETSY})`;
const apply = process.argv.includes("--apply");
const cutoffIso = process.env.PIXART_CUTOFF ?? "2026-09-10T00:00:00.000Z";

async function count(label: string, q: ReturnType<typeof sql>) {
  const r: any = await withSystemContext((tx) => tx.execute(q));
  const n = Number(r.rows?.[0]?.n ?? 0);
  console.log(`${label.padEnd(44)} ${n}`);
  return n;
}

async function run(label: string, q: ReturnType<typeof sql>) {
  if (!apply) return;
  const r: any = await withSystemContext((tx) => tx.execute(q));
  console.log(`  applied ${label}: ${r.rowCount ?? ""}`);
}

async function main() {
  console.log(apply ? "APPLY" : "DRY RUN", "cutoff", cutoffIso);
  await count("mock orders in PixArt", sql`select count(*) n from orders where business_id=${PIXART} and ${MOCK_ORDER}`);
  await count("real orders in PixArt (kept)", sql`select count(*) n from orders where business_id=${PIXART} and not ${MOCK_ORDER}`);
  await count("mock customers", sql`select count(*) n from customers where business_id=${PIXART} and email like '%@example.com'`);
  await count("orphan messages (mailbox mock)", sql`select count(*) n from messages where business_id=${PIXART} and order_id is null`);
  await count("earnings", sql`select count(*) n from earnings where business_id=${PIXART}`);
  await count("print jobs", sql`select count(*) n from print_jobs where business_id=${PIXART}`);
  await count("mock shopify shops", sql`select count(*) n from shops where business_id=${PIXART} and platform='shopify'`);
  await count("mock designers linked", sql`select count(*) n from designer_businesses where business_id=${PIXART}`);

  // 1. children that block or outlive the order delete
  await run("print_jobs", sql`delete from print_jobs where business_id=${PIXART} and (order_id is null or order_id in (select id from orders where business_id=${PIXART} and ${MOCK_ORDER}))`);
  await run("print_reconcile_ledger", sql`delete from print_reconcile_ledger where business_id=${PIXART}`);
  await run("earnings", sql`delete from earnings where business_id=${PIXART}`);
  await run("notifications", sql`delete from notifications where business_id=${PIXART}`);
  await run("notification_fires", sql`delete from notification_fires where business_id=${PIXART}`);
  await run("reminder_fires", sql`delete from reminder_fires where business_id=${PIXART}`);
  await run("alpha_events", sql`delete from alpha_events where business_id=${PIXART}`);
  // activity_log is immutable (app_user cannot delete); its mock rows lose their order_id on cascade and stay as log history
  await run("daily_health_reports", sql`delete from daily_health_reports where business_id=${PIXART}`);
  // 2. the mock orders themselves (cascades items, assets, assignments, qc, proofs, messages, addresses)
  await run("orders", sql`delete from orders where business_id=${PIXART} and ${MOCK_ORDER}`);
  // 3. mailbox mock mail and mock customers
  await run("messages", sql`delete from messages where business_id=${PIXART} and order_id is null`);
  await run("customers", sql`delete from customers where business_id=${PIXART} and id not in (select customer_id from orders where customer_id is not null)`);
  // 4. the mock Shopify shop (a real one gets connected from Settings later)
  await run("print_product_mappings", sql`delete from print_product_mappings where business_id=${PIXART}`);
  await run("ignored_products", sql`delete from ignored_products where business_id=${PIXART}`);
  await run("job_runs (mock shopify)", sql`delete from job_runs where shop_id in (select id from shops where business_id=${PIXART} and platform='shopify')`);
  await run("shops (mock shopify)", sql`delete from shops where business_id=${PIXART} and platform='shopify'`);
  // 5. mock people: detach the seed designers from PixArt (real roster comes from Yousif)
  await run("designer_businesses", sql`delete from designer_businesses where business_id=${PIXART}`);
  // 6. disarm mock mailbox + print creds; no automated customer email until a real mailbox is connected
  await run("business creds", sql`update businesses set gmail_credentials=null, gmail_address=null, gmail_history_id=null, gmail_last_polled_at=null, email_sending_enabled=false, stage_email_auto_send=false, daily_health_email_enabled=false, print_credentials=null where id=${PIXART}`);
  // 6b. real orders placed before the cutoff are history, not queue work
  await run("archive pre-cutoff real orders", sql`update orders set archived_at = now(), archive_reason = 'Imported before shop backfill cutoff' where business_id=${PIXART} and archived_at is null and placed_at < ${cutoffIso}::timestamptz`);
  // 7. Etsy shop: cutoff = today, cursor reset so the next sync is the 60 day window
  await run("etsy shop cfg", sql`update shops set integration_config = (coalesce(integration_config,'{}'::jsonb) - 'syncCursor' - 'syncingSince' - 'lastSyncAt') || jsonb_build_object('backfillCutoffAt', ${cutoffIso}::text) where id=${PIXART_ETSY}`);

  if (apply) {
    console.log("syncing real Etsy receipts (60 day window, archived before cutoff)...");
    const summary = await syncShopReceipts(PIXART_ETSY, { mode: "backfill", trigger: "backfill" });
    console.log(JSON.stringify({ ...summary, errors: summary.errors.slice(0, 5) }));
  }
  await count("orders in PixArt now", sql`select count(*) n from orders where business_id=${PIXART}`);
  await count("live (not archived)", sql`select count(*) n from orders where business_id=${PIXART} and archived_at is null`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
