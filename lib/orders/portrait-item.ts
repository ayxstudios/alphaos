import { asc, eq } from "drizzle-orm";

import type { Tx } from "@/lib/db";
import { orderItems, orders, shops } from "@/lib/db/schema";
import type { ClassifyConfig } from "@/lib/integrations/classify";
import { isAddOnItem, portraitLinesOf } from "@/lib/orders/add-ons";

// The add-on recognizer lives in lib/orders/add-ons.ts (one definition); re-exported for older imports.
export { ADDON_STYLE, isAddOnItem } from "@/lib/orders/add-ons";

/** An order item as far as picking its portrait needs it. */
export type PickableItem = { id: string; title: string | null; sku: string | null; style: string | null };

/**
 * The one item an order is routed by (2026-10-25: a bare `limit 1` read an
 * add-on line first and routed the order with no style). Add-on lines are
 * skipped (an order of nothing but add-ons keeps them all), then an item with
 * a known style comes first, then the lowest id, so the same order always
 * picks the same item. Pure.
 */
export function pickPortraitItem<T extends PickableItem>(items: T[], cfg: ClassifyConfig | null | undefined): T | null {
  if (!items.length) return null;
  const portraits = items.filter((i) => !isAddOnItem(i, cfg));
  const pool = portraits.length ? portraits : items;
  const known = (i: T) => (i.style?.trim() ? 0 : 1);
  return [...pool].sort((a, b) => known(a) - known(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
}

/** The order's shop non-portrait settings (null when the role cannot read shops or the order has no shop). */
export async function loadClassifyConfig(tx: Tx, orderId: string): Promise<ClassifyConfig | null> {
  const [shop] = await tx
    .select({ cfg: shops.integrationConfig })
    .from(orders)
    .leftJoin(shops, eq(shops.id, orders.shopId))
    .where(eq(orders.id, orderId));
  return (shop?.cfg ?? null) as ClassifyConfig | null;
}

/** The order's portrait item with every column, or null when it has no items. */
export async function loadPortraitItem(tx: Tx, orderId: string) {
  const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, orderId)).orderBy(asc(orderItems.id));
  if (items.length < 2) return items[0] ?? null;
  return pickPortraitItem(items, await loadClassifyConfig(tx, orderId));
}

/** The style the order is routed by: its portrait item's, trimmed, or null. */
export async function loadPortraitStyle(tx: Tx, orderId: string): Promise<string | null> {
  return (await loadPortraitItem(tx, orderId))?.style?.trim() || null;
}

/**
 * Every style the order's portraits need, primary first (the one
 * pickPortraitItem routes by), then the other portrait lines' in id order;
 * distinct (any case), trimmed, add-on lines left out. A line with no style
 * adds nothing. Pure.
 */
export function portraitStylesFrom(items: PickableItem[], cfg: ClassifyConfig | null | undefined): string[] {
  const primary = pickPortraitItem(items, cfg);
  const lines = [...portraitLinesOf(items, cfg)].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of [primary, ...lines]) {
    const style = item?.style?.trim();
    if (!style || seen.has(style.toLowerCase())) continue;
    seen.add(style.toLowerCase());
    out.push(style);
  }
  return out;
}

/**
 * The styles an order routes by (2026-10-29: two portraits in two styles on
 * one receipt). One designer draws the whole order, so they must draw every
 * one of these. Empty = no portrait line has a style yet.
 */
export async function portraitStylesOf(tx: Tx, orderId: string): Promise<string[]> {
  const items = await tx
    .select({ id: orderItems.id, title: orderItems.title, sku: orderItems.sku, style: orderItems.style })
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId))
    .orderBy(asc(orderItems.id));
  return portraitStylesFrom(items, items.length > 1 ? await loadClassifyConfig(tx, orderId) : null);
}
