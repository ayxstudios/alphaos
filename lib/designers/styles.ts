import { eq } from "drizzle-orm";

import { withUserContext, type RequestUser } from "@/lib/db";
import { shops } from "@/lib/db/schema";

/**
 * The catalog of choosable portrait styles — the de-duplicated union of every
 * active shop's offered styles. A designer's styles can only be picked from
 * this set (you can only assign styles some shop actually sells). Staff-readable
 * via the shops RLS select policy.
 */
export async function getStyleCatalog(user: RequestUser): Promise<string[]> {
  return withUserContext(user, async (tx) => {
    const rows = await tx
      .select({ styles: shops.styles })
      .from(shops)
      .where(eq(shops.active, true));

    const map = new Map<string, string>(); // lowercase key -> first-seen display
    for (const r of rows) {
      for (const s of r.styles ?? []) {
        const t = s.trim();
        if (!t) continue;
        const key = t.toLowerCase();
        if (!map.has(key)) map.set(key, t);
      }
    }
    return [...map.values()].sort((a, b) => a.localeCompare(b));
  });
}
