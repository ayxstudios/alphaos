import { and, eq, isNull } from "drizzle-orm";

import type { Tx } from "@/lib/db";
import { orders } from "@/lib/db/schema";

/**
 * An order's grand total in the shop's own currency (orders.order_total +
 * order_currency, migration 0062). Read by value-gated quota groups
 * (Yousif 2026-10-16: Mar only takes orders over AUD 300, the PixArt BOGO
 * offer). Null = unknown (manual, Trello, legacy), which never passes a gate.
 */
export type OrderTotal = { amount: number; currency: string | null };

const currencyOf = (c: unknown) => (typeof c === "string" && c.trim() ? c.trim().toUpperCase() : null);

/** Etsy receipt grandtotal {amount, divisor, currency_code}: 33600 / 100 = 336.00 AUD. */
export function etsyReceiptTotal(receipt: unknown): OrderTotal | null {
  const g = (receipt as { grandtotal?: { amount?: unknown; divisor?: unknown; currency_code?: unknown } } | null)
    ?.grandtotal;
  if (!g || typeof g !== "object") return null;
  const amount = Number(g.amount);
  const divisor = Number(g.divisor);
  if (!Number.isFinite(amount) || !Number.isFinite(divisor) || divisor <= 0) return null;
  return { amount: Math.round((amount / divisor) * 100) / 100, currency: currencyOf(g.currency_code) };
}

/** Shopify MoneyV2 {amount: "336.00", currencyCode: "AUD"} (totalPriceSet.shopMoney). */
export function shopifyMoneyTotal(
  money: { amount?: string | number | null; currencyCode?: string | null } | null | undefined,
): OrderTotal | null {
  if (!money || money.amount == null || money.amount === "") return null;
  const amount = Number(money.amount);
  return Number.isFinite(amount) ? { amount, currency: currencyOf(money.currencyCode) } : null;
}

/** Insert values for the two columns. */
export function orderTotalColumns(total: OrderTotal | null | undefined): {
  orderTotal: string | null;
  orderCurrency: string | null;
} {
  return total ? { orderTotal: total.amount.toFixed(2), orderCurrency: total.currency } : { orderTotal: null, orderCurrency: null };
}

/** Fill a missing total on an order that already exists (a reconciled manual order). Never overwrites. */
export async function fillOrderTotal(tx: Tx, orderId: string | undefined, total: OrderTotal | null | undefined): Promise<void> {
  if (!orderId || !total) return;
  await tx
    .update(orders)
    .set(orderTotalColumns(total))
    .where(and(eq(orders.id, orderId), isNull(orders.orderTotal)));
}

/** The order's total for routing, or null when unknown. */
export async function loadOrderTotal(tx: Tx, orderId: string): Promise<OrderTotal | null> {
  const [o] = await tx
    .select({ total: orders.orderTotal, currency: orders.orderCurrency })
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1);
  return toOrderTotal(o?.total, o?.currency);
}

/** Column values (numeric arrives as a string) to an OrderTotal. */
export function toOrderTotal(total: string | number | null | undefined, currency: string | null | undefined): OrderTotal | null {
  if (total == null || total === "") return null;
  const amount = Number(total);
  return Number.isFinite(amount) ? { amount, currency: currencyOf(currency) } : null;
}
