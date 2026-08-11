import { asc, eq } from "drizzle-orm";

import { withUserContext, type RequestUser, type Tx } from "@/lib/db";
import { styles } from "@/lib/db/schema";

export type BusinessStyle = {
  id: string;
  name: string;
  titleMatches: string[];
  skuMatches: string[];
  isDefault: boolean;
  perFigureRate: string | null;
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
  }));
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
