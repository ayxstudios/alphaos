/**
 * Backfill/repair Etsy order items from raw_import, preserve-not-overwrite:
 * - an order with no item rows gets one row per receipt transaction;
 * - a row with no options gets its options/raw variations filled;
 * - a transaction with NO row at all gets one added (2026-10-06: a two-pet
 *   receipt showed only Bubba, Tigger's line was never written);
 * - product_type is re-resolved from the receipt (option value > is_digital
 *   > listing title) and corrected where it differs — except on orders already
 *   printing/shipped/delivered, which are never touched. Never touches a
 *   VA-set field.
 *
 *   npx tsx scripts/backfill-etsy-item-options.ts            # dry run
 *   npx tsx scripts/backfill-etsy-item-options.ts --apply    # writes
 */
import "./load-env";

import { and, eq, isNotNull } from "drizzle-orm";

import { withSystemContext } from "../lib/db";
import { orders, orderItems, type ProductOption } from "../lib/db/schema";
import { etsyImportItems } from "../lib/integrations/etsy/receipt-review";
import { mergeImportItems } from "../lib/orders/reconcile";

const apply = process.argv.includes("--apply");

// Orders whose print run may already be in flight: product_type stays put.
const PRINT_LOCKED = new Set(["printing", "shipped", "delivered"]);

const optionsKey = (options: ProductOption[] | null | undefined) =>
  JSON.stringify((options ?? []).map((o) => [o.name, o.value]));

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

    const results: { number: string | null; status: string; action: string; detail: string }[] = [];
    for (const order of rows) {
      const items = etsyImportItems(order.rawImport);
      if (!items.length) {
        results.push({ number: order.number, status: order.status, action: "no-transactions", detail: "" });
        continue;
      }

      const existing = await tx
        .select({ id: orderItems.id, options: orderItems.options, productType: orderItems.productType })
        .from(orderItems)
        .where(eq(orderItems.orderId, order.id));

      // Rows + options, via the same merge the live reconcile uses.
      if (!existing.length || existing.length < items.length || existing.some((r) => !r.options?.length)) {
        if (apply) {
          const m = await mergeImportItems(tx, { businessId: order.businessId, orderId: order.id, importItems: items });
          if (m.inserted || m.filled)
            results.push({ number: order.number, status: order.status, action: "merge-items", detail: `inserted=${m.inserted} filled=${m.filled}` });
        } else {
          results.push({
            number: order.number,
            status: order.status,
            action: "would-merge-items",
            detail: `rows=${existing.length} txns=${items.length}`,
          });
        }
      }

      // product_type repair, matched by options; in-flight print orders excluded.
      if (PRINT_LOCKED.has(order.status)) continue;
      const current = apply
        ? await tx
            .select({ id: orderItems.id, options: orderItems.options, productType: orderItems.productType })
            .from(orderItems)
            .where(eq(orderItems.orderId, order.id))
        : existing;
      for (const row of current) {
        const item = items.find((it) => optionsKey(it.options) === optionsKey(row.options));
        if (!item || item.productType === row.productType) continue;
        if (apply) {
          await tx.update(orderItems).set({ productType: item.productType }).where(eq(orderItems.id, row.id));
        }
        results.push({
          number: order.number,
          status: order.status,
          action: apply ? "fix-product-type" : "would-fix-product-type",
          detail: `${row.productType} -> ${item.productType}`,
        });
      }
    }
    return results;
  });

  const touched = out.filter((r) => r.action !== "no-transactions");
  for (const r of touched) console.log(`${r.action} ${r.number} (${r.status}) ${r.detail}`);
  const counts: Record<string, number> = {};
  for (const r of out) counts[r.action] = (counts[r.action] ?? 0) + 1;
  console.log(JSON.stringify({ apply, total: out.length, ...counts }));
}

main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });
