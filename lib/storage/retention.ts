import { eq, lt, sql } from "drizzle-orm";

import { withSystemContext } from "@/lib/db";
import { assets } from "@/lib/db/schema";
import { deleteObject } from "./r2";

/**
 * 180-day asset retention (per the brief). A nightly sweep HARD-deletes customer
 * reference/submission photos older than the window — the R2 object AND its
 * asset row — while orders and activity_log persist forever. Only R2-backed
 * assets touch object storage; CDN-referenced rows (Shopify) are dropped too so
 * the reference doesn't outlive the retention window, but nothing is deleted
 * from Shopify's CDN.
 *
 * Callable now (see /api/assets/sweep); wire onto a nightly schedule later.
 */
const RETENTION_DAYS = 180;

export type SweepSummary = { scanned: number; objectsDeleted: number; rowsDeleted: number; errors: number };

export async function sweepExpiredAssets(): Promise<SweepSummary> {
  const summary: SweepSummary = { scanned: 0, objectsDeleted: 0, rowsDeleted: 0, errors: 0 };

  const expired = await withSystemContext((tx) =>
    tx
      .select({ id: assets.id, storage: assets.storage, r2Key: assets.r2Key })
      .from(assets)
      .where(lt(assets.createdAt, sql`now() - interval '${sql.raw(String(RETENTION_DAYS))} days'`))
      .limit(1000),
  );

  for (const a of expired) {
    summary.scanned++;
    try {
      if (a.storage === "r2" && a.r2Key) {
        await deleteObject(a.r2Key);
        summary.objectsDeleted++;
      }
      await withSystemContext((tx) => tx.delete(assets).where(eq(assets.id, a.id)));
      summary.rowsDeleted++;
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
