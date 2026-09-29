import { NextResponse, type NextRequest } from "next/server";
import { and, eq, or, sql } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { withUserContext } from "@/lib/db";
import { customers, orders } from "@/lib/db/schema";
import { cleanSearchTerm, likeContains } from "@/lib/search";

/**
 * Top-bar lookup. An order number (with or without the #) or a buyer name that
 * matches one order jumps straight to it; anything else opens the Orders list
 * with the same search, where every row shows its stage.
 */
export async function GET(request: NextRequest) {
  const session = await auth();
  const home = (path: string) => NextResponse.redirect(new URL(path, request.url));
  if (!session?.user) return home("/login");
  const role = session.user.role;
  const q = cleanSearchTerm(request.nextUrl.searchParams.get("q"));
  if (role === "designer") return home(q ? `/board?q=${encodeURIComponent(q)}` : "/board");
  if (!q) return home("/orders");
  const listing = `/orders?q=${encodeURIComponent(q)}`;

  const bare = q.replace(/^#/, "").trim();
  const found = await withUserContext({ id: session.user.id, role }, async (tx) => {
    const exact = await tx
      .select({ id: orders.id })
      .from(orders)
      .where(
        or(
          sql`lower(${orders.platformOrderName}) in (${bare.toLowerCase()}, ${`#${bare}`.toLowerCase()})`,
          eq(orders.platformOrderId, bare),
        ),
      )
      .limit(2);
    if (exact.length === 1) return exact[0].id;
    if (exact.length > 1) return null;

    const like = likeContains(q);
    const buyer = await tx
      .select({ id: orders.id })
      .from(orders)
      .leftJoin(customers, eq(customers.id, orders.customerId))
      .where(
        and(
          sql`(concat_ws(' ', ${customers.firstName}, ${customers.lastName}) ilike ${like} or ${customers.email} ilike ${like} or ${orders.rawImport}->>'name' ilike ${like})`,
        ),
      )
      .limit(2);
    return buyer.length === 1 ? buyer[0].id : null;
  });

  return home(found ? `/orders/${found}` : listing);
}
