/**
 * Copy production into the staging database (docs/STAGING.md).
 *
 *   SOURCE_URL=<prod owner url> TARGET_URL=<staging owner url> \
 *     npx tsx scripts/staging/clone-prod.ts --yes
 *
 * SOURCE is only READ. TARGET is WIPED (public + drizzle schemas), rebuilt by
 * the same drizzle migrations production ran, checked column for column
 * against the source, then filled table by table in foreign-key order and
 * row-count verified. Refuses to run when both URLs point at one host.
 * Both URLs must be OWNER connections (neondb_owner).
 */
import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { migrate } from "drizzle-orm/neon-serverless/migrator";
import ws from "ws";

neonConfig.webSocketConstructor = ws;

const CHUNK = 500;

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`;

async function main() {
  const sourceUrl = need("SOURCE_URL");
  const targetUrl = need("TARGET_URL");
  const src = new URL(sourceUrl);
  const dst = new URL(targetUrl);
  if (src.hostname.replace("-pooler", "") === dst.hostname.replace("-pooler", "")) {
    throw new Error("SOURCE_URL and TARGET_URL are the same database host; refusing.");
  }
  if (dst.hostname.includes("ep-spring-dawn-audsesft")) {
    throw new Error("TARGET_URL is the production database; refusing.");
  }
  if (!process.argv.includes("--yes")) {
    throw new Error(`This WIPES ${dst.hostname}${dst.pathname}. Re-run with --yes.`);
  }

  const source = new Pool({ connectionString: sourceUrl, max: 2 });
  const target = new Pool({ connectionString: targetUrl, max: 2 });

  // 1. wipe + migrate the target
  console.log(`wipe ${dst.hostname}${dst.pathname}`);
  await target.query(`drop schema if exists drizzle cascade`);
  await target.query(`drop schema if exists public cascade`);
  await target.query(`create schema public`);
  await migrate(drizzle(target), { migrationsFolder: "./lib/db/migrations" });
  console.log("migrations applied");

  // 2. schema parity: every source column must exist on the target, same type
  const colsSql = `select table_name, column_name, udt_name from information_schema.columns
                   where table_schema = 'public' order by table_name, ordinal_position`;
  const key = (r: { table_name: string; column_name: string; udt_name: string }) =>
    `${r.table_name}.${r.column_name}:${r.udt_name}`;
  const srcCols = new Set((await source.query(colsSql)).rows.map(key));
  const dstCols = new Set((await target.query(colsSql)).rows.map(key));
  const missing = [...srcCols].filter((c) => !dstCols.has(c));
  const extra = [...dstCols].filter((c) => !srcCols.has(c));
  if (missing.length || extra.length) {
    throw new Error(`schema drift. only on source: ${missing.join(", ") || "-"}; only on target: ${extra.join(", ") || "-"}`);
  }

  // 3. tables in foreign-key order (parents first)
  const tables: string[] = (
    await source.query(
      `select tablename from pg_tables where schemaname = 'public' and tablename not like '%view%' order by 1`,
    )
  ).rows.map((r: { tablename: string }) => r.tablename);
  const deps = new Map<string, Set<string>>(tables.map((t) => [t, new Set<string>()]));
  for (const r of (
    await source.query(
      `select c.conrelid::regclass::text as t, c.confrelid::regclass::text as ref
       from pg_constraint c join pg_namespace n on n.oid = c.connamespace
       where c.contype = 'f' and n.nspname = 'public'`,
    )
  ).rows as { t: string; ref: string }[]) {
    const t = r.t.replace(/"/g, "");
    const ref = r.ref.replace(/"/g, "");
    if (t !== ref) deps.get(t)?.add(ref);
  }
  const order: string[] = [];
  const seen = new Set<string>();
  const visit = (t: string, stack: Set<string>) => {
    if (seen.has(t)) return;
    if (stack.has(t)) throw new Error(`foreign-key cycle at ${t}`);
    stack.add(t);
    for (const d of deps.get(t) ?? []) visit(d, stack);
    stack.delete(t);
    seen.add(t);
    order.push(t);
  };
  for (const t of tables) visit(t, new Set());

  // 4. copy
  const counts: Record<string, number> = {};
  const client = await target.connect();
  try {
    await client.query("begin");
    for (const t of order) await client.query(`alter table ${q(t)} disable trigger user`);
    for (const t of order) {
      let copied = 0;
      for (let offset = 0; ; offset += CHUNK) {
        const { rows } = await source.query(
          `select coalesce(json_agg(row_to_json(x)), '[]')::text as j, count(*)::int as n
           from (select * from ${q(t)} order by ctid limit ${CHUNK} offset ${offset}) x`,
        );
        const n = rows[0].n as number;
        if (n === 0) break;
        await client.query(
          `insert into ${q(t)} select * from json_populate_recordset(null::${q(t)}, $1::json)`,
          [rows[0].j],
        );
        copied += n;
        if (n < CHUNK) break;
      }
      counts[t] = copied;
    }
    for (const t of order) await client.query(`alter table ${q(t)} enable trigger user`);
    await client.query("commit");
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  // 5. sequences + verify
  const seqs = await target.query(
    `select s.relname as seq, t.relname as tbl, a.attname as col
     from pg_class s join pg_depend d on d.objid = s.oid and d.deptype = 'a'
     join pg_class t on t.oid = d.refobjid join pg_attribute a on a.attrelid = t.oid and a.attnum = d.refobjsubid
     where s.relkind = 'S' and s.relnamespace = 'public'::regnamespace`,
  );
  for (const r of seqs.rows as { seq: string; tbl: string; col: string }[]) {
    await target.query(
      `select setval('${r.seq}', coalesce((select max(${q(r.col)}) from ${q(r.tbl)}), 0) + 1, false)`,
    );
  }
  let bad = 0;
  for (const t of order) {
    const [a, b] = await Promise.all([
      source.query(`select count(*)::int n from ${q(t)}`),
      target.query(`select count(*)::int n from ${q(t)}`),
    ]);
    if (a.rows[0].n !== b.rows[0].n) {
      bad += 1;
      console.log(`MISMATCH ${t}: source=${a.rows[0].n} target=${b.rows[0].n}`);
    }
  }
  console.log(
    Object.entries(counts)
      .filter(([, n]) => n > 0)
      .map(([t, n]) => `${t}=${n}`)
      .join(" "),
  );
  await source.end();
  await target.end();
  if (bad) throw new Error(`${bad} table(s) differ after copy`);
  console.log(`clone OK: ${order.length} tables`);
}

main().catch((err) => {
  console.error("clone failed:", err.cause?.message ?? err.message);
  process.exit(1);
});
