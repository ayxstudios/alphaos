/**
 * One-off: existing Etsy orders imported header-only (before 2026-10-05) have
 * their buyer-chosen variations (Background, Size, Personalization…) only in
 * raw_import. Same rule as the new import path (etsyImportItems): an order
 * with no items gets one row per receipt transaction; an order whose first
 * item has no options gets just the options/raw variations filled. Never
 * touches a VA-set field.
 *
 *   npx tsx scripts/backfill-etsy-item-options.ts            # dry run
 *   npx tsx scripts/backfill-etsy-item-options.ts --apply    # writes
 */
import "./load-env";

import { and, eq, isNotNull } from "drizzle-orm";

import { withSystemContext } from "../lib/db";
import { orders, orderItems } from "../lib/db/schema";
import { etsyImportItems } from "../lib/integrations/etsy/receipt-review";

const apply = process.argv.includes("--apply");

async function main() {
  const out = await withSystemContext(async (tx) => {
    const rows = await tx
      .select({
        id: orders.id,
        businessId: orders.businessId,
        number: orders.platformOrderName,
        status: orders.status,
        rawImport: orders.rawImport,
      })
      .from(orders)
      .where(and(eq(orders.source, "etsy"), isNotNull(orders.rawImport)));

    const results: { number: string | null; status: string; action: string; options: number }[] = [];
    for (const order of rows) {
      const items = etsyImportItems(order.rawImport);
      if (!items.length) {
        results.push({ number: order.number, status: order.status, action: "no-transactions", options: 0 });
        continue;
      }
      const [existing] = await tx
        .select({ id: orderItems.id, options: orderItems.options })
        .from(orderItems)
        .where(eq(orderItems.orderId, order.id))
        .limit(1);
      const optionCount = items.reduce((n, item) => n + item.options.length, 0);
      if (!existing) {
        if (apply) {
          await tx.insert(orderItems).values(
            items.map((item) => ({
              businessId: order.businessId,
              orderId: order.id,
              sku: item.sku,
              title: item.title,
              options: item.options.length ? item.options : null,
              rawVariations: item.rawVariations,
              productType: item.productType,
            })),
          );
        }
        results.push({ number: order.number, status: order.status, action: "insert-items", options: optionCount });
      } else if (!existing.options?.length && items[0].options.length) {
        if (apply) {
          await tx
            .update(orderItems)
            .set({ options: items[0].options, rawVariations: items[0].rawVariations })
            .where(eq(orderItems.id, existing.id));
        }
        results.push({ number: order.number, status: order.status, action: "fill-options", options: items[0].options.length });
      } else {
        results.push({ number: order.number, status: order.status, action: "skip-has-options", options: existing.options?.length ?? 0 });
      }
    }
    return results;
  });

  const touched = out.filter((r) => r.action === "insert-items" || r.action === "fill-options");
  for (const r of touched) console.log(`${apply ? "WROTE" : "WOULD"} ${r.action} ${r.number} (${r.status}) options=${r.options}`);
  const counts: Record<string, number> = {};
  for (const r of out) counts[r.action] = (counts[r.action] ?? 0) + 1;
  console.log(JSON.stringify({ apply, total: out.length, ...counts }));
}

main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });
