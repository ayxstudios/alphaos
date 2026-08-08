import { and, eq, sql } from "drizzle-orm";

import type { Tx } from "@/lib/db";
import { styles, orderItems, activityLog } from "@/lib/db/schema";
import { describeStyleMatch, listBusinessStyles } from "@/lib/designers/styles";

export type Product = { title: string | null; sku: string | null };

/** The key a product is learned on: exact SKU if it has one, else the title. */
export function productKey(p: Product): { kind: "sku" | "title"; value: string } | null {
  const sku = p.sku?.trim();
  if (sku) return { kind: "sku", value: sku };
  const title = p.title?.trim();
  if (title) return { kind: "title", value: title };
  return null;
}

/** Drizzle predicate: an order_items row that IS this product (in a business). */
function productPredicate(businessId: string, p: Product) {
  const key = productKey(p);
  if (!key) return sql`false`;
  return and(
    eq(orderItems.businessId, businessId),
    key.kind === "sku" ? eq(orderItems.sku, key.value) : eq(orderItems.title, key.value),
  );
}

/** How many distinct orders contain this product — the "N orders affected" figure. */
export async function countOrdersForProduct(tx: Tx, businessId: string, p: Product): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(distinct ${orderItems.orderId})::int` })
    .from(orderItems)
    .where(productPredicate(businessId, p));
  return Number(row?.n ?? 0);
}

/** The style a product currently resolves to under the business's rules. */
export async function currentMatchForProduct(tx: Tx, businessId: string, p: Product) {
  const list = await listBusinessStyles(tx, businessId);
  return describeStyleMatch(p.title, p.sku, list);
}

/**
 * Teach a rule: add this product's key (SKU or title) to a style, then set the
 * style on every non-locked order_item of that product across the business.
 * Returns the number of orders updated. Idempotent on the rule array.
 */
export async function learnProductStyle(
  tx: Tx,
  businessId: string,
  styleId: string,
  p: Product,
): Promise<{ ruleKind: "sku" | "title"; ruleValue: string; styleName: string; orders: number }> {
  const key = productKey(p);
  if (!key) throw new Error("Product has no SKU or title to learn on");

  const [style] = await tx
    .select({ name: styles.name, titleMatches: styles.titleMatches, skuMatches: styles.skuMatches })
    .from(styles)
    .where(and(eq(styles.id, styleId), eq(styles.businessId, businessId)));
  if (!style) throw new Error("Style not found");

  if (key.kind === "sku") {
    if (!style.skuMatches.some((m) => m.trim().toLowerCase() === key.value.toLowerCase())) {
      await tx.update(styles).set({ skuMatches: [...style.skuMatches, key.value] }).where(eq(styles.id, styleId));
    }
  } else {
    if (!style.titleMatches.some((m) => m.trim().toLowerCase() === key.value.toLowerCase())) {
      await tx.update(styles).set({ titleMatches: [...style.titleMatches, key.value] }).where(eq(styles.id, styleId));
    }
  }

  const updated = await tx
    .update(orderItems)
    .set({ style: style.name })
    .where(and(productPredicate(businessId, p), eq(orderItems.styleLocked, false)))
    .returning({ orderId: orderItems.orderId });
  const orders = new Set(updated.map((u) => u.orderId)).size;
  return { ruleKind: key.kind, ruleValue: key.value, styleName: style.name, orders };
}

/** Every learned-rule action lands here so "why does X map to Y" is answerable. */
export async function logStyleLearning(
  tx: Tx,
  input: {
    businessId: string;
    actorId: string | null;
    orderId?: string | null;
    action: "style.learned" | "style.set_once" | "style.ignored" | "style.unignored" | "style.rule_changed";
    metadata: Record<string, unknown>;
  },
): Promise<void> {
  await tx.insert(activityLog).values({
    businessId: input.businessId,
    orderId: input.orderId ?? null,
    actorId: input.actorId,
    action: input.action,
    metadata: input.metadata,
  });
}
