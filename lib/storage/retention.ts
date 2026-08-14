import { and, eq, isNull, lt, sql } from "drizzle-orm";

import { withSystemContext } from "@/lib/db";
import { assets } from "@/lib/db/schema";
import { pruneJobRunsOlderThan } from "@/lib/jobs/ledger";
import { deleteObject } from "./r2";

/**
 * 180-day asset retention (per the brief). A nightly sweep HARD-deletes the R2
 * object for every R2-backed asset older than the window, then MARKS the asset
 * row deleted (deleted_at). The row is kept for the order's audit trail — the
 * bytes are gone, the record persists — and orders + activity_log persist
 * forever. CDN references (Shopify) consume no storage and are left untouched.
 *
 * Callable now (see /api/assets/sweep); wire onto a nightly schedule later.
 */
const RETENTION_DAYS = 180;
const DEFAULT_BUDGET_MS = 50_000; // stay under a 60s function limit
const BATCH = 500;

export type SweepSummary = {
  scanned: number;
  objectsDeleted: number;
  rowsMarked: number;
  errors: number;
  jobRunsPruned: number;
  incomplete: boolean; // true => more remain; the next nightly run resumes
};

/**
 * Batch-and-resume: oldest-expired first, bounded by a wall-clock budget. Marked
 * rows (deleted_at) are excluded from the next query, so re-running continues
 * where this left off — a backlog drains over successive nightly runs.
 */
export async function sweepExpiredAssets(opts: { budgetMs?: number } = {}): Promise<SweepSummary> {
  const budgetMs = opts.budgetMs ?? DEFAULT_BUDGET_MS;
  const summary: SweepSummary = { scanned: 0, objectsDeleted: 0, rowsMarked: 0, errors: 0, jobRunsPruned: 0, incomplete: false };
  const start = Date.now();

  const expired = await withSystemContext((tx) =>
    tx
      .select({ id: assets.id, r2Key: assets.r2Key })
      .from(assets)
      .where(
        and(
          eq(assets.storage, "r2"),
          isNull(assets.deletedAt),
          lt(assets.createdAt, sql`now() - interval '${sql.raw(String(RETENTION_DAYS))} days'`),
        ),
      )
      .orderBy(assets.createdAt)
      .limit(BATCH),
  );

  for (const a of expired) {
    if (Date.now() - start > budgetMs) {
      summary.incomplete = true;
      break;
    }
    summary.scanned++;
    try {
      if (a.r2Key) {
        await deleteObject(a.r2Key);
        summary.objectsDeleted++;
      }
      await withSystemContext((tx) =>
        tx.update(assets).set({ deletedAt: new Date() }).where(eq(assets.id, a.id)),
      );
      summary.rowsMarked++;
    } catch (e) {
      summary.errors++;
      console.log(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: "error",
          component: "retention",
          event: "sweep_asset_failed",
          assetId: a.id,
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    }
  }

  // A full batch likely means more remain even if we didn't hit the time budget.
  if (expired.length === BATCH) summary.incomplete = true;
  summary.jobRunsPruned = await pruneJobRunsOlderThan(30);

  console.log(
    JSON.stringify({ ts: new Date().toISOString(), component: "retention", event: "sweep_complete", ...summary }),
  );
  return summary;
}
