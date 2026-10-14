/**
 * Backfill order_items.quantity from the Etsy receipts (two portraits in one
 * email, 2026-10-14). Every line that existed before migration 0058 holds
 * quantity 1; a line bought as "Quantity: 2" needs 2 so the order gets two
 * portrait slots. Etsy only: orders.raw_import.transactions[].quantity is the
 * source. Shopify keeps no payload to read; its quantity lands at import and on
 * a re-resolve.
 *
 * order_items has no transaction id, so each row is paired with its
 * transaction the way the import paired them (title + options; the lone row of
 * a lone transaction; the one row and one transaction left over), see
 * matchItemQuantities. A row that cannot be paired without guessing is left
 * alone and counted. Only rows whose quantity differs are written, so a second
 * run changes nothing.
 *
 *   BACKFILL_DB_URL=<owner connection> npx tsx scripts/backfill-item-quantity.ts --dry-run
 *   BACKFILL_DB_URL=<owner connection> npx tsx scripts/backfill-item-quantity.ts
 *
 * Runs on the OWNER connection (RLS would hide rows from app_user). The URL is
 * read from BACKFILL_DB_URL only, never from .env.local, so it cannot fall back
 * to another database by accident. One transaction: it all lands or none of it.
 */
import { and, asc, eq, gt, inArray, isNotNull, ne } from "drizzle-orm";
import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import ws from "ws";

import * as schema from "../lib/db/schema";
import { orderItems, orders } from "../lib/db/schema";
import type { Tx } from "../lib/db";
import { etsyImportItems } from "../lib/integrations/etsy/receipt-review";
import { matchItemQuantities } from "../lib/orders/item-quantity";

const PAGE = 200;

export type QuantityChange = { order: string | null; itemId: string; from: number; to: number; how: string };
export type QuantityBackfillReport = {
  dryRun: boolean;
  /** Etsy orders that carry a stored receipt. */
  orders: number;
  /** Their order_items rows. */
  items: number;
  /** Rows paired with a transaction, by how. */
  paired: { single: number; matched: number; leftover: number };
  /** Paired rows whose quantity was already right. */
  alreadyRight: number;
  /** Rows written (dry run: rows that would be written). */
  updated: number;
  /** Rows left alone: no safe pairing, or the receipt has no transactions. */
  skipped: { ambiguous: number; unmatched: number; noTransactions: number };
  /** Rows now (or after the real run) holding a quantity above 1. */
  multiUnitRows: number;
  changes: QuantityChange[];
};

export async function backfillItemQuantity(tx: Tx, opts: { dryRun: boolean }): Promise<QuantityBackfillReport> {
  const report: QuantityBackfillReport = {
    dryRun: opts.dryRun,
    orders: 0,
    items: 0,
    paired: { single: 0, matched: 0, leftover: 0 },
    alreadyRight: 0,
    updated: 0,
    skipped: { ambiguous: 0, unmatched: 0, noTransactions: 0 },
    multiUnitRows: 0,
    changes: [],
  };

  let after: string | null = null;
  for (;;) {
    const batch: { id: string; number: string | null; rawImport: unknown }[] = await tx
      .select({ id: orders.id, number: orders.platformOrderName, rawImport: orders.rawImport })
      .from(orders)
      .where(and(eq(orders.source, "etsy"), isNotNull(orders.rawImport), after ? gt(orders.id, after) : undefined))
      .orderBy(asc(orders.id))
      .limit(PAGE);
    if (!batch.length) break;
    after = batch[batch.length - 1].id;
    report.orders += batch.length;

    const rows = await tx
      .select({
        id: orderItems.id,
        orderId: orderItems.orderId,
        title: orderItems.title,
        options: orderItems.options,
        quantity: orderItems.quantity,
      })
      .from(orderItems)
      .where(inArray(orderItems.orderId, batch.map((o) => o.id)));
    const byOrder = new Map<string, typeof rows>();
    for (const r of rows) byOrder.set(r.orderId, [...(byOrder.get(r.orderId) ?? []), r]);

    for (const order of batch) {
      const items = byOrder.get(order.id) ?? [];
      if (!items.length) continue;
      report.items += items.length;
      const lines = etsyImportItems(order.rawImport);
      if (!lines.length) {
        report.skipped.noTransactions += items.length;
        report.multiUnitRows += items.filter((i) => i.quantity > 1).length;
        continue;
      }
      const byId = new Map(items.map((i) => [i.id, i]));
      for (const m of matchItemQuantities(items, lines)) {
        const item = byId.get(m.itemId)!;
        if (m.quantity === null || m.how === "ambiguous" || m.how === "unmatched") {
          report.skipped[m.how === "ambiguous" ? "ambiguous" : "unmatched"]++;
          if (item.quantity > 1) report.multiUnitRows++;
          continue;
        }
        report.paired[m.how]++;
        if (m.quantity > 1) report.multiUnitRows++;
        if (item.quantity === m.quantity) {
          report.alreadyRight++;
          continue;
        }
        if (!opts.dryRun) {
          // The guard makes the write itself conditional, so a concurrent run
          // or a re-run can never rewrite a row that is already right.
          await tx
            .update(orderItems)
            .set({ quantity: m.quantity })
            .where(and(eq(orderItems.id, item.id), ne(orderItems.quantity, m.quantity)));
        }
        report.updated++;
        report.changes.push({ order: order.number, itemId: item.id, from: item.quantity, to: m.quantity, how: m.how });
      }
    }
  }
  return report;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const url = process.env.BACKFILL_DB_URL;
  if (!url) throw new Error("BACKFILL_DB_URL (owner connection) is required");
  if (new URL(url).username !== "neondb_owner") throw new Error("BACKFILL_DB_URL must be the owner connection");

  neonConfig.webSocketConstructor = ws;
  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool, { schema });
  try {
    const report = await db.transaction((tx) => backfillItemQuantity(tx, { dryRun }));
    for (const c of report.changes.slice(0, 50)) {
      console.log(`${dryRun ? "would set" : "set"} order ${c.order} item ${c.itemId}: ${c.from} -> ${c.to} (${c.how})`);
    }
    if (report.changes.length > 50) console.log(`... and ${report.changes.length - 50} more`);
    console.log(JSON.stringify({ ...report, changes: undefined, changed: report.changes.length }));
  } finally {
    await pool.end();
  }
}

// Run only when started as a script, so a test harness can import the function.
if (process.argv[1] && /backfill-item-quantity\.[cm]?[jt]s$/.test(process.argv[1])) {
  main().then(
    () => process.exit(0),
    (err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
