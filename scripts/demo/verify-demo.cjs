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
  const kinds = await pool.query("select type, count(*)::int n from assets where deleted_at is null group by type order by type");
  const refCov = await pool.query(`
    select count(*)::int total,
      count(*) filter (where exists (select 1 from assets a where a.order_id = o.id and a.type = 'reference' and a.deleted_at is null))::int with_ref
    from orders o where o.status <> 'cancelled'`);
  const subCov = await pool.query(`
    select count(*)::int total,
      count(*) filter (where exists (select 1 from assets a where a.order_id = o.id and a.type in ('submission','final') and a.deleted_at is null))::int with_sub
    from orders o where o.status in ('awaiting_qc','awaiting_approval','approved','printing','shipped','delivered','complete')`);
  const badUrls = await pool.query("select count(*)::int n from assets where url is not null and url not like 'https://alphaos-demo.vercel.app/demo/%'");
  const ready = await pool.query(`
    select b.slug, count(*)::int n from orders o join businesses b on b.id = o.business_id
    where o.status = 'ready_to_assign' and o.archived_at is null
      and not exists (select 1 from assignments a where a.order_id = o.id and a.active)
      and exists (select 1 from assets r where r.order_id = o.id and r.type = 'reference' and r.deleted_at is null)
    group by b.slug order by b.slug`);
  const readyTotal = ready.rows.reduce((n, r) => n + r.n, 0);
  const pairChk = await pool.query(`
    select count(*)::int total, count(*) filter (where p.url is not null and r.url is not null and r.url = p.url)::int ok from (
      select distinct on (order_id) order_id, url from assets where type in ('submission','final') and deleted_at is null order by order_id, created_at
    ) s
    left join lateral (select url from assets where order_id = s.order_id and type = 'reference' and deleted_at is null order by created_at, id limit 1) r on true
    left join (values ('cartoon-01','pet-01'),('cartoon-02','pet-02'),('cartoon-03','people-01'),('watercolor-01','pet-03'),('watercolor-02','pet-04'),('watercolor-03','people-02'),('renaissance-01','pet-05'),('renaissance-02','pet-05'),('renaissance-03','people-05'),('lineart-01','pet-06'),('lineart-02','people-03'),('lineart-03','people-04')) v(a,ph) on s.url like '%/' || v.a || '.%'
    left join lateral (select regexp_replace(r.url, '/photos/[^/]+$', '/photos/' || v.ph || '.jpg') url) p on true`);
  const pixart = await pool.query("select count(*)::int n from businesses where name ilike '%pixart%'");

  console.log("\nbusinesses:");
  for (const r of businesses.rows) console.log(`  ${r.name} (${r.slug})`);
  console.log("\nusers by role:");
  for (const r of users.rows) console.log(`  ${r.role}: ${r.n}`);
  console.log("\norders per status:");
  for (const r of orders.rows) console.log(`  ${r.status}: ${r.n}`);
  console.log(`\nawaiting_qc orders: ${qcTotal.rows[0].n} total, ${qc.rows[0].n} with a submission asset`);
  console.log(`ready_to_assign (unassigned, with reference photos): ${readyTotal} (${ready.rows.map((r) => `${r.slug} ${r.n}`).join(", ")})`);
  console.log(`orders whose first reference photo is the photo their submission was drawn from: ${pairChk.rows[0].ok} of ${pairChk.rows[0].total}`);
  console.log(`assets: ${assetSplit.rows[0].total} total, ${assetSplit.rows[0].demo_urls} /demo/ url(s), ${assetSplit.rows[0].picsum_urls} picsum url(s)`);

  console.log("\nassets by kind:");
  for (const r of kinds.rows) console.log(`  ${r.type}: ${r.n}`);
  console.log(`orders with >=1 reference photo: ${refCov.rows[0].with_ref} of ${refCov.rows[0].total} (non-cancelled)`);
  console.log(`orders at/past awaiting_qc with a submission/final: ${subCov.rows[0].with_sub} of ${subCov.rows[0].total}`);
  console.log(`assets with a url outside https://alphaos-demo.vercel.app/demo/: ${badUrls.rows[0].n}${badUrls.rows[0].n ? "  <-- FLAGGED" : ""}`);

  await pool.end();

  if (refCov.rows[0].with_ref < refCov.rows[0].total || subCov.rows[0].with_sub < subCov.rows[0].total) {
    console.error("\nFAIL: image coverage incomplete");
    process.exit(1);
  }
  if (ready.rows.length < 2 || ready.rows.some((r) => r.n < 3) || readyTotal < 6) {
    console.error("\nFAIL: ready_to_assign >= 6 (3 per business) not met");
    process.exit(1);
  }
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
