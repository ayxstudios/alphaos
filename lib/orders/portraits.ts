import { asc, eq } from "drizzle-orm";

import type { Tx } from "@/lib/db";
import { orderItems } from "@/lib/db/schema";

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
 * The order's portrait slots in stable order. Callers show a per-portrait
 * picker only when there are 2+ (a single-item order keeps today's flow).
 */
export async function getOrderPortraits(tx: Tx, orderId: string): Promise<OrderPortrait[]> {
  const items = await tx
    .select({ id: orderItems.id, title: orderItems.title, variation: orderItems.variation })
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId))
    .orderBy(asc(orderItems.id));
  return items.map((item, i) => ({ id: item.id, n: i + 1, label: portraitLabel(item) }));
}
