import { eq } from "drizzle-orm";

import type { Tx } from "@/lib/db";
import { orderItems, orders, shops } from "@/lib/db/schema";
import { resolveFigureCount, type FigureConfig, type NormalizedVariation } from "@/lib/integrations/figures";
import { parseEtsyReceiptReview } from "@/lib/integrations/etsy/receipt-review";
import { countsInText } from "@/lib/orders/text-counts";

/**
 * Work out an unresolved item's figure count from data the order already holds,
 * so nobody is asked to type what the order already says. Pure: no writes.
 *
 * Only EXPLICIT sources count (a shop/default option rule, or the stored Etsy
 * receipt's own "Number of ..." option). figure_count drives designer pay, so
 * anything unclear, or contradicted by the buyer's own words, stays null.
 */
export function inferItemFigureCount(input: {
  rawVariations: unknown;
  options: unknown;
  config: FigureConfig | null;
  rawImport: unknown;
  itemCount: number;
}): { count: number; note: string } | null {
  const pairs = (v: unknown): NormalizedVariation[] =>
    Array.isArray(v)
      ? v.flatMap((x) =>
          x && typeof x === "object" && typeof (x as { name?: unknown }).name === "string"
            ? [{ name: (x as NormalizedVariation).name, value: String((x as NormalizedVariation).value ?? "") }]
            : [],
        )
      : [];

  const review = parseEtsyReceiptReview(input.rawImport);
  const freeText = [review.combinedPersonalization, review.buyerNote].filter(Boolean).join("\n");
  const stated = [...new Set(countsInText(freeText))];

  let found: { count: number; note: string } | null = null;
  for (const source of [pairs(input.rawVariations), pairs(input.options)]) {
    if (!source.length) continue;
    const fig = resolveFigureCount(source, input.config);
    if (fig.count != null && fig.source === "shop_rule") {
      found = { count: fig.count, note: fig.note };
      break;
    }
  }
  // The stored Etsy receipt, only when it maps one-to-one onto the single item.
  if (!found && input.itemCount === 1 && review.transactions.length === 1) {
    const n = review.transactions[0].figureCount;
    if (n != null) found = { count: n, note: "from the stored Etsy receipt option" };
  }
  if (!found) return null;
  if (found.count < 1 || found.count > 20) return null;
  if (stated.some((n) => n !== found!.count)) return null; // options vs buyer words disagree
  return found;
}

/**
 * Fill every null figure_count on the order from what it already knows. Returns
 * how many items are STILL unresolved afterwards (those need a person).
 */
export async function autoResolveOrderFigures(tx: Tx, orderId: string): Promise<number> {
  const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, orderId));
  const pending = items.filter((i) => i.figureCount == null);
  if (!pending.length) return 0;
  const [meta] = await tx
    .select({ rawImport: orders.rawImport, config: shops.integrationConfig })
    .from(orders)
    .innerJoin(shops, eq(shops.id, orders.shopId))
    .where(eq(orders.id, orderId))
    .limit(1);
  let left = 0;
  for (const item of pending) {
    const hit = inferItemFigureCount({
      rawVariations: item.rawVariations,
      options: item.options,
      config: (meta?.config ?? null) as FigureConfig | null,
      rawImport: meta?.rawImport ?? null,
      itemCount: items.length,
    });
    if (!hit) {
      left++;
      continue;
    }
    await tx
      .update(orderItems)
      .set({ figureCount: hit.count, figureCountSource: "shop_rule" })
      .where(eq(orderItems.id, item.id));
  }
  return left;
}
