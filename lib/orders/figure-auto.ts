import { eq } from "drizzle-orm";

import type { Tx } from "@/lib/db";
import { activityLog, orderItems, orders, shops } from "@/lib/db/schema";
import { applyStyleFigureDefault, resolveFigureCount, type FigureConfig, type NormalizedVariation } from "@/lib/integrations/figures";
import { mentionsFiguresInNote, mentionsPeopleOrPets, readCountFromVariations, titleNamesSingleSubject } from "@/lib/integrations/figure-values";
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
export type FigureInference = { count: number; note: string; source: "shop_rule" | "heuristic" };

export function inferItemFigureCount(input: {
  rawVariations: unknown;
  options: unknown;
  config: FigureConfig | null;
  rawImport: unknown;
  itemCount: number;
  /** The item's CURRENT style (a VA often sets it after import); feeds the shop's styleFigureDefaults. */
  style?: string | null;
  /** The listing title ("Custom Watercolor House Portrait"); a one-subject title is one figure. */
  title?: string | null;
  productType?: "digital" | "physical" | null;
}): FigureInference | null {
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

  let found: FigureInference | null = null;
  // Stated numbers the found count may legitimately equal (the buyer counting only the extras on "Venue +2 people/pets").
  let agrees: number[] | null = null;
  const sources = [pairs(input.rawVariations), pairs(input.options)];
  for (const source of sources) {
    if (!source.length) continue;
    const fig = resolveFigureCount(source, input.config);
    if (fig.count != null && fig.source === "shop_rule") {
      found = { count: fig.count, note: fig.note, source: "shop_rule" };
      break;
    }
  }
  // The stored Etsy receipt, only when it maps one-to-one onto the single item.
  if (!found && input.itemCount === 1 && review.transactions.length === 1) {
    const n = review.transactions[0].figureCount;
    if (n != null) found = { count: n, note: "from the stored Etsy receipt option", source: "shop_rule" };
  }
  // Option names and values read the way a person would: "House & 4 Figure/pet" is 5, "Venue Only" is 1,
  // "Number Of People/Pets: 2 Figures+Background" is 2. Never guesses past an option it cannot read.
  const reading = readCountFromVariations(dedupe(sources.flat()));
  if (!found && reading.status === "count") {
    found = { count: reading.count, note: reading.note, source: "shop_rule" };
    agrees = reading.agrees;
  }
  // Only when NO option talks about a count: the shop's default for the item's current style, then a
  // listing that names one subject and nobody else.
  if (!found && reading.status === "none") {
    const fig = applyStyleFigureDefault({ count: null, source: "unresolved", note: "" }, input.style, input.config);
    if (fig.count != null) found = { count: fig.count, note: fig.note, source: "shop_rule" };
  }
  if (!found && reading.status === "none" && input.productType !== "physical") {
    if (titleNamesSingleSubject(input.title) && !mentionsPeopleOrPets(input.title) && !mentionsFiguresInNote(freeText)) {
      found = { count: 1, note: `listing "${input.title}" names one subject and nobody else`, source: "heuristic" };
    }
  }
  if (!found) return null;
  if (found.count < 1 || found.count > 20) return null;
  if (stated.some((n) => n !== found!.count && !(agrees ?? []).includes(n))) return null; // options vs buyer words disagree
  return found;
}

function dedupe(list: NormalizedVariation[]): NormalizedVariation[] {
  const seen = new Set<string>();
  return list.filter((v) => {
    const k = `${v.name}\u0000${v.value}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
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
      style: item.style,
      title: item.title,
      productType: item.productType,
    });
    if (!hit) {
      left++;
      continue;
    }
    await tx
      .update(orderItems)
      .set({ figureCount: hit.count, figureCountSource: hit.source })
      .where(eq(orderItems.id, item.id));
    await tx.insert(activityLog).values({
      businessId: item.businessId,
      orderId,
      actorId: null,
      action: "order.figure_count_auto",
      fromState: null,
      toState: null,
      metadata: { count: hit.count, note: hit.note, itemId: item.id, source: hit.source },
    });
  }
  return left;
}
