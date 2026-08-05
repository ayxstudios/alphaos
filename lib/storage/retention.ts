import { and, eq, isNull, lt, sql } from "drizzle-orm";

import { withSystemContext } from "@/lib/db";
import { assets } from "@/lib/db/schema";
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

export type SweepSummary = { scanned: number; objectsDeleted: number; rowsMarked: number; errors: number };

export async function sweepExpiredAssets(): Promise<SweepSummary> {
  const summary: SweepSummary = { scanned: 0, objectsDeleted: 0, rowsMarked: 0, errors: 0 };

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
      .limit(1000),
  );

  for (const a of expired) {
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

  console.log(
    JSON.stringify({ ts: new Date().toISOString(), component: "retention", event: "sweep_complete", ...summary }),
  );
  return summary;
}
