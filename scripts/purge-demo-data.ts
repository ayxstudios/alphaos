/**
 * Remove every piece of fake data (2026-09-10, Ayser: "get rid of the fake data"):
 * the demo business and all its rows, and the seed VA / designer people.
 * Only the admin login and the real PixArt business survive.
 *
 *   npx tsx scripts/purge-demo-data.ts            # dry run: counts
 *   npx tsx scripts/purge-demo-data.ts --apply
 *
 * Runs on the OWNER connection (DIRECT_URL) because activity_log is immutable
 * for app_user and businesses are referenced with ON DELETE RESTRICT.
 */
import "./load-env";

import { Pool } from "@neondatabase/serverless";

const DEMO_SLUG = process.env.DEMO_SLUG ?? "lumina";
const FAKE_USERS = ["va1@aystudios.io", "va2@aystudios.io", "d1@aystudios.io", "d2@aystudios.io", "d3@aystudios.io"];
const PIXART = "5e784759-93aa-40f9-a5f5-696ace0bc323";
const apply = process.argv.includes("--apply");

// Children first; every one of these carries business_id.
const BUSINESS_TABLES = [
  "print_jobs", "print_reconcile_ledger", "earnings", "notifications", "notification_fires", "reminder_fires",
  "alpha_events", "daily_health_reports", "qc_checks", "proofs", "assignments", "assets", "order_items",
  "order_shipping_addresses", "messages", "orders", "customers", "print_product_mappings", "ignored_products",
  "email_sender_ignores", "email_templates", "styles", "designer_businesses", "job_runs", "shops", "activity_log",
];

async function main() {
  const url = process.env.DIRECT_URL;
  if (!url) throw new Error("DIRECT_URL missing");
  const pool = new Pool({ connectionString: url });
  const q = async (text: string, params: unknown[] = []) => (await pool.query(text, params));

  const biz = (await q(`select id, name from businesses where slug = $1`, [DEMO_SLUG])).rows[0];
  console.log(apply ? "APPLY" : "DRY RUN", "demo business:", biz ?? "(none)");
  const users = (await q(`select id, email, name from "user" where email = any($1)`, [FAKE_USERS])).rows;
  console.log("fake users:", users.map((u) => `${u.name} <${u.email}>`).join(", ") || "(none)");

  if (biz) {
    for (const t of BUSINESS_TABLES) {
      const n = Number((await q(`select count(*) n from ${t} where business_id = $1`, [biz.id])).rows[0].n);
      if (!n && !apply) continue;
      if (apply) {
        const r = await q(`delete from ${t} where business_id = $1`, [biz.id]);
        console.log(`  ${t}: ${r.rowCount}`);
      } else console.log(`  ${t}: ${n}`);
    }
    if (apply) {
      const r = await q(`delete from businesses where id = $1`, [biz.id]);
      console.log(`  businesses: ${r.rowCount}`);
    }
  }

  // Mock-era log lines in PixArt lost their order on cascade; drop them too.
  const orphan = Number((await q(`select count(*) n from activity_log where business_id = $1 and order_id is null`, [PIXART])).rows[0].n);
  console.log(`PixArt orphan activity_log rows: ${orphan}`);
  if (apply && orphan) await q(`delete from activity_log where business_id = $1 and order_id is null`, [PIXART]);

  if (users.length && apply) {
    const ids = users.map((u) => u.id);
    for (const t of ["login_attempts"]) await q(`delete from ${t} where email = any($1)`, [FAKE_USERS]).catch(() => {});
    const r = await q(`delete from "user" where id = any($1)`, [ids]);
    console.log(`  users: ${r.rowCount}`);
  }

  const left = (await q(`select (select count(*) from businesses) b, (select count(*) from "user") u, (select count(*) from orders) o, (select count(*) from customers) c, (select count(*) from shops) s`)).rows[0];
  console.log("remaining:", left);
  await pool.end();
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
