// Helper for scripts/demo/seed-demo.sh: prints a verification table for the
// demo database and exits non-zero if the seed didn't actually land (no
// awaiting_qc order has a submission asset, or a business is still named
// after PixArt). Reads DIRECT_URL from the environment.
const { Pool, neonConfig } = require("@neondatabase/serverless");
const ws = require("ws");

neonConfig.webSocketConstructor = ws;

async function main() {
  const pool = new Pool({ connectionString: process.env.DIRECT_URL, max: 1 });

  const businesses = await pool.query("select name, slug from businesses order by name");
  const users = await pool.query('select role, count(*)::int n from "user" group by role order by role');
  const orders = await pool.query("select status, count(*)::int n from orders group by status order by status");
  const qc = await pool.query(`
    select count(*)::int n from orders o
    where o.status = 'awaiting_qc' and o.archived_at is null
      and exists (select 1 from assets a where a.order_id = o.id and a.type in ('submission','final') and a.deleted_at is null)
  `);
  const qcTotal = await pool.query("select count(*)::int n from orders where status = 'awaiting_qc' and archived_at is null");
  const assetSplit = await pool.query(`
    select
      count(*)::int total,
      count(*) filter (where url like '/demo/%' or url like '%/demo/%')::int demo_urls,
      count(*) filter (where url like '%picsum.photos%')::int picsum_urls
    from assets where url is not null
  `);
  const pixart = await pool.query("select count(*)::int n from businesses where name ilike '%pixart%'");

  console.log("\nbusinesses:");
  for (const r of businesses.rows) console.log(`  ${r.name} (${r.slug})`);
  console.log("\nusers by role:");
  for (const r of users.rows) console.log(`  ${r.role}: ${r.n}`);
  console.log("\norders per status:");
  for (const r of orders.rows) console.log(`  ${r.status}: ${r.n}`);
  console.log(`\nawaiting_qc orders: ${qcTotal.rows[0].n} total, ${qc.rows[0].n} with a submission asset`);
  console.log(`assets: ${assetSplit.rows[0].total} total, ${assetSplit.rows[0].demo_urls} /demo/ url(s), ${assetSplit.rows[0].picsum_urls} picsum url(s)`);

  await pool.end();

  if (qc.rows[0].n < 1) {
    console.error("\nFAIL: no awaiting_qc order has a submission asset");
    process.exit(1);
  }
  if (pixart.rows[0].n > 0) {
    console.error('\nFAIL: a business name contains "PixArt"');
    process.exit(1);
  }
  console.log("\nOK: demo database verified");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
