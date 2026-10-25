import { asc, eq } from "drizzle-orm";

import { withUserContext, type RequestUser, type Tx } from "@/lib/db";
import { orderItems, styles } from "@/lib/db/schema";
import { ADDON_STYLE, loadClassifyConfig, pickPortraitItem, type PickableItem } from "@/lib/orders/portrait-item";

export type BusinessStyle = {
  id: string;
  name: string;
  titleMatches: string[];
  skuMatches: string[];
  isDefault: boolean;
  perFigureRate: string | null;
  /** Made by the agent for a product it had never seen: no designer picked yet. */
  autoCreated?: boolean;
};

/**
 * A business's portrait styles (raw tx so it works in both the system import
 * context and a staff request). Ordered by name for a deterministic first-match.
 */
export async function listBusinessStyles(tx: Tx, businessId: string): Promise<BusinessStyle[]> {
  const rows = await tx
    .select({
      id: styles.id,
      name: styles.name,
      titleMatches: styles.titleMatches,
      skuMatches: styles.skuMatches,
      isDefault: styles.isDefault,
      perFigureRate: styles.perFigureRate,
      autoCreated: styles.autoCreated,
    })
    .from(styles)
    .where(eq(styles.businessId, businessId))
    .orderBy(asc(styles.name));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    titleMatches: r.titleMatches ?? [],
    skuMatches: r.skuMatches ?? [],
    isDefault: r.isDefault,
    perFigureRate: r.perFigureRate,
    autoCreated: r.autoCreated,
  }));
}


/**
 * The style a product ROUTES by when nobody set one (2026-10-23: CPS watercolor
 * pets and couples were completed with no style and went to whoever ranked
 * first). An exact SKU rule, else the LONGEST title rule the title contains.
 * Never the business default, never an auto-created or add-on style, and null
 * when two different styles tie, so a person picks instead of a guess.
 */
export function routingStyleMatch(
  title: string | null | undefined,
  sku: string | null | undefined,
  businessStyles: BusinessStyle[],
): string | null {
  const usable = businessStyles.filter((st) => !st.autoCreated && !ADDON_STYLE.test(st.name));
  const s = (sku ?? "").trim().toLowerCase();
  if (s) {
    const bySku = new Set(usable.filter((st) => st.skuMatches.some((m) => m.trim().toLowerCase() === s)).map((st) => st.name));
    if (bySku.size === 1) return [...bySku][0];
    if (bySku.size > 1) return null;
  }
  const t = (title ?? "").toLowerCase();
  if (!t) return null;
  let best = 0;
  let names = new Set<string>();
  for (const st of usable) {
    for (const m of st.titleMatches) {
      const key = m.trim().toLowerCase();
      if (!key || !t.includes(key) || key.length < best) continue;
      if (key.length > best) {
        best = key.length;
        names = new Set();
      }
      names.add(st.name);
    }
  }
  return names.size === 1 ? [...names][0] : null;
}

/** The business routes by style at all: it has a style a person set up (not add-on, not auto-created). */
export async function hasRoutingStyles(tx: Tx, businessId: string): Promise<boolean> {
  return (await listBusinessStyles(tx, businessId)).some((st) => !st.autoCreated && !ADDON_STYLE.test(st.name));
}

/**
 * Give every style-less item of an order its routing style (unlocked, a rule
 * chose it) and return the order's style afterwards (its portrait item's, so an
 * add-on line never hides the portrait's). Items that already have
 * a style stay as they are; nothing matched = nothing written.
 */
export async function fillRoutingStyle(tx: Tx, businessId: string, orderId: string): Promise<string | null> {
  const items = await tx
    .select({ id: orderItems.id, title: orderItems.title, sku: orderItems.sku, style: orderItems.style })
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId))
    .orderBy(asc(orderItems.id));
  const catalog = items.some((i) => !i.style?.trim()) ? await listBusinessStyles(tx, businessId) : [];
  const filled: PickableItem[] = [];
  for (const item of items) {
    let style = item.style?.trim() || null;
    if (!style) {
      style = routingStyleMatch(item.title, item.sku, catalog);
      if (style) await tx.update(orderItems).set({ style, styleLocked: false }).where(eq(orderItems.id, item.id));
    }
    filled.push({ ...item, style });
  }
  return pickPortraitItem(filled, filled.length > 1 ? await loadClassifyConfig(tx, orderId) : null)?.style ?? null;
}

export type StyleMatch = {
  /** The resolved style name, or null when nothing matched and there's no default. */
  style: string | null;
  /** The id of the style that matched (null for default/none). */
  styleId: string | null;
  /** How it was decided. "sku"/"title" mean a product-specific learned rule. */
  via: "sku" | "title" | "default" | "none";
};

/**
 * Resolve a product's style. Precedence: an exact SKU rule (the precise learned
 * product key) beats a title-contains rule, which beats the business default.
 * Never guesses — SKU is exact and title rules are explicit substrings.
 */
export function describeStyleMatch(
  title: string | null | undefined,
  sku: string | null | undefined,
  businessStyles: BusinessStyle[],
): StyleMatch {
  const s = (sku ?? "").trim().toLowerCase();
  if (s) {
    for (const st of businessStyles) {
      if (st.skuMatches.some((m) => m.trim().toLowerCase() === s)) {
        return { style: st.name, styleId: st.id, via: "sku" };
      }
    }
  }
  const t = (title ?? "").toLowerCase();
  if (t) {
    for (const st of businessStyles) {
      if (st.titleMatches.some((m) => m.trim() && t.includes(m.trim().toLowerCase()))) {
        return { style: st.name, styleId: st.id, via: "title" };
      }
    }
  }
  const def = businessStyles.find((st) => st.isDefault);
  if (def) return { style: def.name, styleId: def.id, via: "default" };
  return { style: null, styleId: null, via: "none" };
}

/** The resolved style name (import/re-resolve use this). */
export function matchStyle(
  title: string | null | undefined,
  sku: string | null | undefined,
  businessStyles: BusinessStyle[],
): string | null {
  return describeStyleMatch(title, sku, businessStyles).style;
}

/**
 * The style-name catalog for the current workspace — what a designer's styles
 * can be chosen from. Style eligibility for auto-assign is matched by name.
 */
export async function getStyleCatalog(user: RequestUser, businessId: string): Promise<string[]> {
  return withUserContext(user, async (tx) => {
    const list = await listBusinessStyles(tx, businessId);
    return list.map((s) => s.name);
  });
}

/**
 * The style choices an order form offers for a shop: the shop's own list when
 * an admin set one (Settings), else the business's portrait styles (/styles).
 * Without the fallback a shop with no list showed "No styles configured" and a
 * VA could not set the style while completing an imported order.
 */
export async function shopStyleChoices(tx: Tx, businessId: string, shopStyles: string[] | null | undefined): Promise<string[]> {
  const own = (shopStyles ?? []).map((s) => s.trim()).filter(Boolean);
  if (own.length) return own;
  return (await listBusinessStyles(tx, businessId)).map((s) => s.name);
}
