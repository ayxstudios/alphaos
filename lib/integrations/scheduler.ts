import { and, eq, sql } from "drizzle-orm";

import { withSystemContext } from "@/lib/db";
import { shops } from "@/lib/db/schema";
import { syncShopReceipts } from "@/lib/integrations/etsy";
import { syncShopOrders } from "@/lib/integrations/shopify";

/**
 * Cron entry point: incrementally sync every already-onboarded shop, fair across
 * invocations and bounded by a wall-clock budget so a single run never risks the
 * function timeout (batch-and-resume).
 *
 * - Only shops with a `syncCursor` are eligible — the expensive first 60-day sync
 *   is run once manually (Settings → Backfill), never by cron. Cron does the
 *   small incremental deltas.
 * - Shops are ordered least-recently-synced first; each successful shop sync
 *   stamps `lastSyncAt`, so the next tick continues with whatever this one
 *   didn't reach.
 * - Each shop sync already self-locks (`syncingSince`) and advances its cursor
 *   only on full success, so overlap and partial runs are safe.
 */
const DEFAULT_BUDGET_MS = 50_000; // stay comfortably under a 60s function limit

export type SyncAllResult = {
  budgetMs: number;
  processed: number;
  skippedOverBudget: number;
  shops: { shopId: string; platform: string; outcome: string }[];
};

export async function syncAllShops(opts: { budgetMs?: number } = {}): Promise<SyncAllResult> {
  const budgetMs = opts.budgetMs ?? DEFAULT_BUDGET_MS;

  const shopRows = await withSystemContext((tx) =>
    tx
      .select({ id: shops.id, platform: shops.platform })
      .from(shops)
      .where(
        and(
          eq(shops.active, true),
          // Onboarded = has an incremental cursor; skip never-synced shops.
          sql`(${shops.integrationConfig} ->> 'syncCursor') is not null`,
        ),
      )
      .orderBy(sql`(${shops.integrationConfig} ->> 'lastSyncAt') asc nulls first`),
  );

  const start = Date.now();
  const result: SyncAllResult = { budgetMs, processed: 0, skippedOverBudget: 0, shops: [] };

  for (const s of shopRows) {
    if (Date.now() - start > budgetMs) {
      result.skippedOverBudget++;
      continue; // its lastSyncAt stays oldest → picked up first next tick
    }

    let outcome = "ok";
    try {
      const summary = s.platform === "etsy" ? await syncShopReceipts(s.id) : await syncShopOrders(s.id);
      outcome = summary.skippedRun
        ? `skipped:${summary.skippedRun}`
        : `imported ${summary.imported}, reconciled ${summary.reconciled ?? 0}, failed ${summary.failed}`;
    } catch (e) {
      outcome = `error:${e instanceof Error ? e.message : String(e)}`;
    }

    result.processed++;
    result.shops.push({ shopId: s.id, platform: s.platform, outcome });
  }

  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      component: "scheduler",
      event: "sync_all",
      processed: result.processed,
      skippedOverBudget: result.skippedOverBudget,
    }),
  );
  return result;
}
