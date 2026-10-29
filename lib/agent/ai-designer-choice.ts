import { eq } from "drizzle-orm";

import type { Tx } from "@/lib/db";
import { orders } from "@/lib/db/schema";
import { findStyle } from "@/lib/agent/ai-core";
import { portraitStylesOf } from "@/lib/orders/portrait-item";

/**
 * True when a human may hand this order to the AI Studio designer: its product's
 * style has the AI designer on. Portraits in 2+ styles never (one portrait per job).
 */
export async function aiDesignerChoosable(tx: Tx, orderId: string): Promise<boolean> {
  const [o] = await tx.select({ businessId: orders.businessId }).from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!o) return false;
  const styles = await portraitStylesOf(tx, orderId);
  if (styles.length > 1) return false;
  const style = await findStyle(tx, o.businessId, styles[0] ?? null);
  return !!style?.aiDesignerEnabled;
}
