import { eq } from "drizzle-orm";

import { withUserContext, type RequestUser } from "@/lib/db";
import { orders } from "@/lib/db/schema";

/**
 * The chat widget sends `orderId` and `page` from the browser, and both go to
 * the Alpha relay, which can look the order up with system access. Security QA
 * round 2 (P2): a designer could name any order (not assigned to them) and have
 * the relay answer about it. The order is kept only when the caller can see it
 * under their own RLS context; otherwise it is dropped, and a page path that
 * names a hidden order (/orders/<id>, /qc/<id>) is cut back to its section.
 */
export async function scopeChatOrder(
  user: RequestUser,
  input: { orderId: string | null; page: string | null },
): Promise<{ orderId: string | null; page: string | null }> {
  const visible = async (id: string) => {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) return false;
    const [row] = await withUserContext(user, (tx) =>
      tx.select({ id: orders.id }).from(orders).where(eq(orders.id, id)).limit(1),
    );
    return !!row;
  };

  const orderId = input.orderId && (await visible(input.orderId)) ? input.orderId : null;

  let page = input.page;
  const named = page?.match(/^\/(orders|qc)\/([^/?#]+)/);
  if (page && named && named[2] !== orderId && !(await visible(decodeURIComponent(named[2])))) {
    page = `/${named[1]}`;
  }
  return { orderId, page };
}
