import { asc, eq } from "drizzle-orm";

import type { Tx } from "@/lib/db";
import { orderItems } from "@/lib/db/schema";
import type { ClassifyConfig } from "@/lib/integrations/classify";
import { portraitLinesOf } from "@/lib/orders/add-ons";
import { listBusinessStyles, routingStyleMatch, type BusinessStyle } from "@/lib/designers/styles";
import { loadClassifyConfig } from "@/lib/orders/portrait-item";

/** An order item as far as setting its style needs it. */
export type StyleItem = { id: string; title: string | null; sku: string | null; style: string | null; styleLocked: boolean };

/** One item's new style and lock. */
export type ItemStyleWrite = { id: string; style: string; styleLocked: boolean };

/**
 * What each item's style becomes when a style is set for the whole order
 * (2026-10-29: a receipt with a Watercolor People and a Disney Pet portrait
 * kept one style, so the second portrait was routed and briefed as the first).
 * Pure.
 *  - One portrait line: it takes the chosen style, as before.
 *  - 2+ portrait lines: a style a person set (locked) stays; else the line's
 *    own catalog match (its SKU or title rule); only a line that matches
 *    nothing takes the chosen style.
 *  - Add-on lines get no style.
 * `allowed` drops a catalog match the shop does not offer. Returns only the
 * lines whose style or lock changes.
 */
export function planItemStyles(input: {
  items: StyleItem[];
  chosen: string | null;
  chosenLocked: boolean;
  catalog: BusinessStyle[];
  cfg: ClassifyConfig | null | undefined;
  allowed?: (style: string) => boolean;
}): ItemStyleWrite[] {
  const chosen = input.chosen?.trim() || null;
  const portraits = portraitLinesOf(input.items, input.cfg);
  const plan: ItemStyleWrite[] = [];
  for (const item of portraits) {
    let next: { style: string; styleLocked: boolean } | null = null;
    if (portraits.length === 1) {
      next = chosen ? { style: chosen, styleLocked: input.chosenLocked } : null;
    } else if (item.styleLocked && item.style?.trim()) {
      next = null;
    } else {
      const own = routingStyleMatch(item.title, item.sku, input.catalog);
      if (own && (!input.allowed || input.allowed(own))) next = { style: own, styleLocked: false };
      else if (chosen) next = { style: chosen, styleLocked: input.chosenLocked };
    }
    if (next && (next.style !== item.style || next.styleLocked !== item.styleLocked)) plan.push({ id: item.id, ...next });
  }
  return plan;
}

/**
 * Set an order's style per portrait line (planItemStyles) and write it.
 * Returns every portrait line's style afterwards, in id order, for the log.
 */
export async function applyOrderStyle(
  tx: Tx,
  input: {
    orderId: string;
    businessId: string;
    chosen: string | null;
    chosenLocked: boolean;
    allowed?: (style: string) => boolean;
    /** Already-loaded items (e.g. locked FOR UPDATE by the caller); read here when absent. */
    items?: StyleItem[];
  },
): Promise<{ id: string; style: string | null }[]> {
  const items =
    input.items ??
    (await tx
      .select({ id: orderItems.id, title: orderItems.title, sku: orderItems.sku, style: orderItems.style, styleLocked: orderItems.styleLocked })
      .from(orderItems)
      .where(eq(orderItems.orderId, input.orderId))
      .orderBy(asc(orderItems.id)));
  const cfg = items.length > 1 ? await loadClassifyConfig(tx, input.orderId) : null;
  const multi = portraitLinesOf(items, cfg).length > 1;
  const plan = planItemStyles({
    items,
    chosen: input.chosen,
    chosenLocked: input.chosenLocked,
    catalog: multi ? await listBusinessStyles(tx, input.businessId) : [],
    cfg,
    allowed: input.allowed,
  });
  for (const w of plan) {
    await tx.update(orderItems).set({ style: w.style, styleLocked: w.styleLocked }).where(eq(orderItems.id, w.id));
  }
  const after = new Map(plan.map((w) => [w.id, w.style]));
  return portraitLinesOf(items, cfg).map((i) => ({ id: i.id, style: after.get(i.id) ?? i.style }));
}
