import { asc, eq } from "drizzle-orm";

import type { Tx } from "@/lib/db";
import { orderItems, orders, shops } from "@/lib/db/schema";
import { isNonPortraitLine, type ClassifyConfig } from "@/lib/integrations/classify";
import { ADD_ON_TITLE } from "@/lib/orders/portraits";

/** Add-on listings (Print & Ship, upgrades) carry a style row but nothing to draw: never a route. */
export const ADDON_STYLE = /print\s*&\s*ship|add-?on/i;

/** An order item as far as picking its portrait needs it. */
export type PickableItem = { id: string; title: string | null; sku: string | null; style: string | null };

/**
 * An add-on line (Print & Ship, rush, upgrade): the shop's non-portrait SKU or
 * title list, the built-in add-on title words, or an add-on style name. It
 * rides along with a portrait and is never what the order is routed by.
 */
export function isAddOnItem(item: { title?: string | null; sku?: string | null; style?: string | null }, cfg: ClassifyConfig | null | undefined): boolean {
  return (
    isNonPortraitLine({ sku: item.sku, title: item.title }, cfg) ||
    ADD_ON_TITLE.test(item.title ?? "") ||
    ADDON_STYLE.test(item.style ?? "")
  );
}

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
