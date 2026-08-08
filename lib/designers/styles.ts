import { asc, eq } from "drizzle-orm";

import { withUserContext, type RequestUser, type Tx } from "@/lib/db";
import { styles } from "@/lib/db/schema";

export type BusinessStyle = {
  id: string;
  name: string;
  titleMatches: string[];
  isDefault: boolean;
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
      isDefault: styles.isDefault,
    })
    .from(styles)
    .where(eq(styles.businessId, businessId))
    .orderBy(asc(styles.name));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    titleMatches: r.titleMatches ?? [],
    isDefault: r.isDefault,
  }));
}

/**
 * Resolve a product's style from a business's styles. The first style whose any
 * title match is contained in the product title wins; otherwise the business's
 * default style; otherwise null. Never guesses — matches are explicit substrings.
 */
export function matchStyle(
  title: string | null | undefined,
  businessStyles: BusinessStyle[],
): string | null {
  const t = (title ?? "").toLowerCase();
  if (t) {
    for (const s of businessStyles) {
      if (s.titleMatches.some((m) => m.trim() && t.includes(m.trim().toLowerCase()))) {
        return s.name;
      }
    }
  }
  return businessStyles.find((s) => s.isDefault)?.name ?? null;
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
