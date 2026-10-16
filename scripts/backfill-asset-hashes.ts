/**
 * Backfill assets.dhash / width / height (wrong-file stop, migration 0060) and
 * assets.fine_sig (its second look, migration 0061) for the files of orders
 * placed in the last N days (default 60), newest first, so the lookalike guard
 * has something to compare a new upload against.
 *
 *   BACKFILL_DB_URL=<owner connection> npx tsx scripts/backfill-asset-hashes.ts --dry-run
 *   BACKFILL_DB_URL=<owner connection> npx tsx scripts/backfill-asset-hashes.ts [--days 60] [--limit 5000] [--concurrency 6]
 *
 * Needs the R2 env (R2_* as in .env.local) to read stored files, and stops
 * before hashing anything when it cannot read them: on 16 Oct an R2_* inherited
 * from the parent shell (another app's bucket) made every stored file look
 * unreadable and 1024 were skipped without a word. Owner connection only (RLS
 * would hide rows from app_user); the URL is read from BACKFILL_DB_URL alone so
 * it never falls back to another database. Safe to repeat: only rows missing a
 * hash or a fine signature are touched, one small UPDATE per file (no long
 * transaction), and a file that cannot be decoded (PDF, HEIC, deleted,
 * unreachable) is skipped and counted, never an error.
 */
import "./load-env";
import { and, desc, gte, isNull, or } from "drizzle-orm";
import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import ws from "ws";
import { eq, inArray, sql } from "drizzle-orm";

import * as schema from "../lib/db/schema";
import { assets, orders } from "../lib/db/schema";
import { hashColumnsFor } from "../lib/qc/asset-hash";
import { readStoredHead } from "../lib/uploads/store";

function argNum(flag: string, fallback: number): number {
  const i = process.argv.indexOf(flag);
  const n = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Null when any of these stored files can be read (one deleted object never stops the run), else why none could. */
async function whyUnreadable(keys: string[]): Promise<string | null> {
  let why: string | null = null;
  for (const key of keys) {
    try {
      await readStoredHead(key, 16);
      return null;
    } catch (e) {
      why = e instanceof Error ? e.message : String(e);
    }
  }
  return why;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const days = argNum("--days", 60);
  const limit = argNum("--limit", 5000);
  const concurrency = argNum("--concurrency", 6);
  const url = process.env.BACKFILL_DB_URL;
  if (!url) throw new Error("BACKFILL_DB_URL (owner connection) is required");
  if (new URL(url).username !== "neondb_owner") throw new Error("BACKFILL_DB_URL must be the owner connection");
  neonConfig.webSocketConstructor = ws;
  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool, { schema });
  const since = new Date(Date.now() - days * 24 * 3600 * 1000);
  try {
    const recent = db
      .select({ id: orders.id })
      .from(orders)
      .where(gte(sql`coalesce(${orders.placedAt}, ${orders.createdAt})`, since));
    const rows = await db
      .select({ id: assets.id, storage: assets.storage, url: assets.url, r2Key: assets.r2Key })
      .from(assets)
      .where(
        and(
          or(isNull(assets.dhash), isNull(assets.fineSig)),
          isNull(assets.deletedAt),
          inArray(assets.orderId, recent),
          inArray(assets.type, ["reference", "submission", "final"]),
        ),
      )
      .orderBy(desc(assets.createdAt))
      .limit(limit);
    const why = await whyUnreadable(rows.flatMap((r) => (r.storage === "r2" && r.r2Key ? [r.r2Key] : [])).slice(0, 3));
    if (why) {
      throw new Error(
        `cannot read stored files with these R2 settings (${why}). Nothing was hashed. ` +
          "An R2_* already set in the parent shell wins over .env.local and --env-file.",
      );
    }
    let hashed = 0;
    let skipped = 0;
    let next = 0;
    const worker = async () => {
      while (next < rows.length) {
        const r = rows[next++];
        const cols = await hashColumnsFor(r);
        if (!cols.dhash) {
          skipped++;
          continue;
        }
        if (!dryRun) await db.update(assets).set(cols).where(eq(assets.id, r.id));
        hashed++;
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    console.log(JSON.stringify({ dryRun, days, candidates: rows.length, hashed, skippedNotImageOrUnreadable: skipped }));
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
