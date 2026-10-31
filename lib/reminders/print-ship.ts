// Print and ship vs digital, for every road that follows up on a proof.
//
// Yousif 2026-10-31: "We also shouldn't be following up on email for digital
// items (we will go ahead if we don't hear back. It doesn't make sense). Just
// leave it in their court. Even print and ship orders shouldn't go out without
// final approval from the customer."
//
// So a digital proof gets no reminder and no "customer silent" alert, and a
// print and ship proof is reminded but never approved on silence. An order is
// print and ship when the buyer bought something we post: a line the import
// marked physical (it needs positive evidence, lib/integrations/etsy/
// receipt-review.ts transactionFulfillment) or, as the daemon's print road does
// for an order whose lines missed it, an Etsy receipt line that IS the Print &
// Ship add-on (CPS listing 1231801819, or an invoiced "Print & Ship for order
// ..." listing). In the 45 days to 31 Oct 2026 the add-on was the only receipt
// line naming Print & Ship, three of its twelve orders with no physical line.
// The title must start with it: a listing that merely offers "Digital or Print
// & Ship" says nothing about what she bought.

import { and, inArray, sql } from "drizzle-orm";

import type { Tx } from "@/lib/db";
import { orders } from "@/lib/db/schema";

const ADD_ON_LISTING_ID = "1231801819";
const PRINT_SHIP_RECEIPT_TITLE = "^[[:space:]]*print[[:space:]]*(&amp;|&|and|[+])[[:space:]]*ship";

/** SQL condition on `orders`: the buyer bought print and ship. */
export function printShipWhere() {
  return sql`(exists (select 1 from order_items oi where oi.order_id = ${orders.id} and oi.product_type = 'physical')
    or exists (select 1 from jsonb_array_elements(case jsonb_typeof(${orders.rawImport}->'transactions') when 'array' then ${orders.rawImport}->'transactions' else '[]'::jsonb end) t
      where t->>'listing_id' = ${ADD_ON_LISTING_ID} or coalesce(t->>'title', '') ~* ${PRINT_SHIP_RECEIPT_TITLE}))`;
}

/** The orders among `orderIds` that are print and ship. */
export async function printShipOrderIds(tx: Tx, orderIds: string[]): Promise<Set<string>> {
  const ids = [...new Set(orderIds)];
  if (!ids.length) return new Set();
  const rows = await tx
    .select({ id: orders.id })
    .from(orders)
    .where(and(inArray(orders.id, ids), printShipWhere()));
  return new Set(rows.map((r) => r.id));
}

export async function isPrintShipOrder(tx: Tx, orderId: string): Promise<boolean> {
  return (await printShipOrderIds(tx, [orderId])).has(orderId);
}
