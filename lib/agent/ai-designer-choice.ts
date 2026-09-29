import { asc, eq } from "drizzle-orm";

import type { Tx } from "@/lib/db";
import { orderItems, orders } from "@/lib/db/schema";
import { findStyle } from "@/lib/agent/ai-core";

/** True when a human may hand this order to the AI Studio designer: its product's style has the AI designer on. */
export async function aiDesignerChoosable(tx: Tx, orderId: string): Promise<boolean> {
  const [o] = await tx.select({ businessId: orders.businessId }).from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!o) return false;
  const [item] = await tx
    .select({ style: orderItems.style })
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId))
    .orderBy(asc(orderItems.id))
    .limit(1);
  const style = await findStyle(tx, o.businessId, item?.style ?? null);
  return !!style?.aiDesignerEnabled;
}
