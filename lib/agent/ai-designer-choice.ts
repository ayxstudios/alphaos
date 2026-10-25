import { eq } from "drizzle-orm";

import type { Tx } from "@/lib/db";
import { orders } from "@/lib/db/schema";
import { findStyle } from "@/lib/agent/ai-core";
import { loadPortraitStyle } from "@/lib/orders/portrait-item";

/** True when a human may hand this order to the AI Studio designer: its product's style has the AI designer on. */
export async function aiDesignerChoosable(tx: Tx, orderId: string): Promise<boolean> {
  const [o] = await tx.select({ businessId: orders.businessId }).from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!o) return false;
  const style = await findStyle(tx, o.businessId, await loadPortraitStyle(tx, orderId));
  return !!style?.aiDesignerEnabled;
}
