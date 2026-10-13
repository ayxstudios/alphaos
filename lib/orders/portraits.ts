import { asc, eq } from "drizzle-orm";

import type { Tx } from "@/lib/db";
import { orderItems, orders, shops } from "@/lib/db/schema";
import { isNonPortraitLine, type ClassifyConfig } from "@/lib/integrations/classify";

/**
 * One portrait slot on an order: an order item a designer can tag an upload
 * with. Numbered by stable item order (id asc), the same order the
 * personalization panel's "Item N" captions use, so "Portrait 2" means the
 * same thing on the card, in QC and on the customer's proof page.
 */
export type OrderPortrait = {
  id: string;
  /** 1-based number, stable for the life of the order. */
  n: number;
  /** Short human label ("Two Pets Watercolor · 8x10"), may be empty. */
  label: string;
};

/** Build the short label a portrait slot shows next to its number. */
export function portraitLabel(item: { title: string | null; variation: string | null }): string {
  const text = [item.title, item.variation]
    .map((part) => (part ?? "").trim())
    .filter(Boolean)
    .join(" · ");
  return text.length > 70 ? `${text.slice(0, 67)}…` : text;
}

/**
 * Add-on lines that ride along with a portrait (print & ship, rush, upgrades)
 * are never a portrait of their own, even when a shop has not listed them in
 * its non-portrait settings.
 */
const ADD_ON_TITLE = /^\s*(add[\s-]?on|rush|upgrade|express|priority)\b|\bprint\s*(&|and)\s*ship/i;

/**
 * The order's portrait slots in stable order: its order items minus add-on
 * lines (the shop's non-portrait SKU/title list plus ADD_ON_TITLE). Callers
 * show a per-portrait picker only when there are 2+ (a single-portrait order
 * keeps today's flow).
 */
export async function getOrderPortraits(tx: Tx, orderId: string): Promise<OrderPortrait[]> {
  const items = await tx
    .select({ id: orderItems.id, title: orderItems.title, variation: orderItems.variation, sku: orderItems.sku })
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId))
    .orderBy(asc(orderItems.id));
  if (items.length < 2) return items.map((item, i) => ({ id: item.id, n: i + 1, label: portraitLabel(item) }));
  // A role that cannot read shops (RLS) simply gets no shop list: the
  // built-in add-on pattern still applies.
  const [shop] = await tx
    .select({ cfg: shops.integrationConfig })
    .from(orders)
    .leftJoin(shops, eq(shops.id, orders.shopId))
    .where(eq(orders.id, orderId));
  const cfg = (shop?.cfg ?? null) as ClassifyConfig | null;
  const portraits = items.filter((item) => !isNonPortraitLine(item, cfg) && !ADD_ON_TITLE.test(item.title ?? ""));
  // Every line an add-on (should not happen): keep them all rather than none.
  const slots = portraits.length ? portraits : items;
  return slots.map((item, i) => ({ id: item.id, n: i + 1, label: portraitLabel(item) }));
}
