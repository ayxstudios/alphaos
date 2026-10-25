import { and, asc, eq } from "drizzle-orm";

import type { Tx } from "@/lib/db";
import { orderItems, orders, shops } from "@/lib/db/schema";
import { isNonPortraitLine, type ClassifyConfig } from "@/lib/integrations/classify";
import { clampItemQuantity } from "@/lib/orders/item-quantity";

/**
 * One portrait slot on an order: one unit of an order item, what a designer
 * tags an upload with and what a proof email carries. A line bought with
 * quantity 2 is two slots. Numbered by stable item order (id asc), then unit,
 * the same order the personalization panel's "Item N" captions use, so
 * "Portrait 2" means the same thing on the card, in QC and in the email.
 */
export type OrderPortrait = {
  /** The slot's stable id: the item id for unit 1, `${itemId}:${unit}` after (see slotKeyOf). */
  key: string;
  itemId: string;
  /** 1-based unit within the item; an item with quantity q has units 1 to q. */
  unit: number;
  /** 1-based number across the whole order, stable for the life of the order. */
  n: number;
  /** Short human label ("Two Pets Watercolor · 8x10 · 2 of 3"), may be empty. */
  label: string;
};

/** The longest label a slot shows next to its number. */
const MAX_LABEL = 70;

/** Build the short label a portrait slot shows next to its number. */
export function portraitLabel(item: { title: string | null; variation: string | null }, max = MAX_LABEL): string {
  const text = [item.title, item.variation]
    .map((part) => (part ?? "").trim())
    .filter(Boolean)
    .join(" · ");
  return text.length > max ? `${text.slice(0, max - 3)}…` : text;
}

/** The label of one unit: the item's label alone for quantity 1, else "... · 2 of 3" within the same length. */
function unitLabel(item: { title: string | null; variation: string | null }, unit: number, quantity: number): string {
  if (quantity === 1) return portraitLabel(item);
  const suffix = `${unit} of ${quantity}`;
  const base = portraitLabel(item, MAX_LABEL - suffix.length - 3);
  return base ? `${base} · ${suffix}` : suffix;
}

/**
 * Add-on lines that ride along with a portrait (print & ship, rush, upgrades)
 * are never a portrait of their own, even when a shop has not listed them in
 * its non-portrait settings.
 */
export const ADD_ON_TITLE = /^\s*(add[\s-]?on|rush|upgrade|express|priority)\b|\bprint\s*(&|and)\s*ship/i;

/** An order item as far as the slot builder needs it. */
export type PortraitItem = {
  id: string;
  title: string | null;
  variation: string | null;
  sku: string | null;
  quantity: number;
};

export type PortraitSlotOptions = {
  /**
   * One slot per order line whatever its quantity (key = item id, unit 1, n =
   * the line's number). Only the customer's proof page uses this, so its
   * numbering and sections stay exactly as they were before quantities counted.
   */
  perLine?: boolean;
};

/**
 * The slots for an order's items (pure; getOrderPortraits loads the inputs).
 * `items` arrive in stable item order. Add-on / non-portrait lines are left
 * out (the shop's non-portrait SKU/title list plus ADD_ON_TITLE), but only
 * when the order has 2+ lines and some line stays: a lone line is always a
 * portrait, and an order whose every line is an add-on keeps them all.
 */
export function buildPortraitSlots(
  items: PortraitItem[],
  cfg: ClassifyConfig | null,
  opts: PortraitSlotOptions = {},
): OrderPortrait[] {
  const portraits =
    items.length < 2
      ? items
      : items.filter((item) => !isNonPortraitLine(item, cfg) && !ADD_ON_TITLE.test(item.title ?? ""));
  const lines = portraits.length ? portraits : items;
  const slots: OrderPortrait[] = [];
  for (const item of lines) {
    const quantity = opts.perLine ? 1 : clampItemQuantity(item.quantity);
    for (let unit = 1; unit <= quantity; unit++) {
      slots.push({
        key: unit === 1 ? item.id : `${item.id}:${unit}`,
        itemId: item.id,
        unit,
        n: slots.length + 1,
        label: unitLabel(item, unit, quantity),
      });
    }
  }
  return slots;
}

/**
 * The order's portrait slots in stable order. Callers show a per-portrait
 * picker only when there are 2+ (a single-portrait order keeps today's flow).
 */
export async function getOrderPortraits(
  tx: Tx,
  orderId: string,
  opts: PortraitSlotOptions = {},
): Promise<OrderPortrait[]> {
  const items = await tx
    .select({
      id: orderItems.id,
      title: orderItems.title,
      variation: orderItems.variation,
      sku: orderItems.sku,
      quantity: orderItems.quantity,
    })
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId))
    .orderBy(asc(orderItems.id));
  if (items.length < 2) return buildPortraitSlots(items, null, opts);
  // A role that cannot read shops (RLS) simply gets no shop list: the
  // built-in add-on pattern still applies.
  const [shop] = await tx
    .select({ cfg: shops.integrationConfig })
    .from(orders)
    .leftJoin(shops, eq(shops.id, orders.shopId))
    .where(eq(orders.id, orderId));
  return buildPortraitSlots(items, (shop?.cfg ?? null) as ClassifyConfig | null, opts);
}

/**
 * The slot key an upload belongs to, from its assets columns. A NULL
 * portrait_unit reads as unit 1 here (every upload before units counted was
 * stored that way), but on a line of 2+ portraits a NULL unit only says "one
 * of this line's portraits": lib/proofs/files.ts matches those by upload
 * order. Writers store the unit explicitly (resolveSlotTag). Null = the upload
 * is not tagged to a portrait.
 */
export function slotKeyOf(tag: { orderItemId: string | null; portraitUnit: number | null }): string | null {
  if (!tag.orderItemId) return null;
  const unit = tag.portraitUnit;
  return unit != null && Number.isInteger(unit) && unit >= 2 ? `${tag.orderItemId}:${unit}` : tag.orderItemId;
}

/** A slot key back into its item id and unit; null when it is not a slot key. */
export function parseSlotKey(key: unknown): { itemId: string; unit: number } | null {
  if (typeof key !== "string") return null;
  const m = /^([^\s:]+)(?::([1-9][0-9]*))?$/.exec(key);
  if (!m) return null;
  const unit = m[2] === undefined ? 1 : Number(m[2]);
  return Number.isSafeInteger(unit) ? { itemId: m[1], unit } : null;
}

/**
 * The assets columns to write for an upload tagged with a slot key, or null
 * when the tag does not fit this order (not a slot key, an item of another
 * order, a unit above the item's quantity): the caller refuses the upload
 * rather than store a tag that misleads QC and the customer's email. The
 * unit is always stored, unit 1 included, so the file says exactly which
 * portrait it is even if the line's quantity changes later.
 */
export async function resolveSlotTag(
  tx: Tx,
  orderId: string,
  key: string,
): Promise<{ orderItemId: string; portraitUnit: number | null } | null> {
  const parsed = parseSlotKey(key);
  if (!parsed) return null;
  const [item] = await tx
    .select({ id: orderItems.id, quantity: orderItems.quantity })
    .from(orderItems)
    .where(and(eq(orderItems.id, parsed.itemId), eq(orderItems.orderId, orderId)))
    .limit(1);
  if (!item || parsed.unit > clampItemQuantity(item.quantity)) return null;
  return { orderItemId: item.id, portraitUnit: parsed.unit };
}
