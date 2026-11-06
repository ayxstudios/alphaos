import { eq, sql } from "drizzle-orm";

import type { Tx } from "@/lib/db";
import { orderItems, printJobs } from "@/lib/db/schema";

/**
 * Digital orders close on the buyer's yes (Yousif 2026-11-06: "Autocomplete
 * digital orders once the buyer approves but they can still ask for touchups
 * at a later date"). Once she approves a digital proof nothing is owed, so the
 * order moves approved -> complete in the same transaction and leaves every
 * board, the print queue and the Overdue view. A later change request still
 * works: complete -> in_design is a revision edge (lib/orders/transitions.ts),
 * the Orders page offers it, and the designer's clock restarts from that day.
 *
 * The rule is pure so it can be tested without a database; the loader reads
 * the two facts it needs.
 */
export type AutoCompleteInput = {
  items: { productType: "digital" | "physical" }[];
  printJobs: number;
};

export type AutoCompleteVerdict = { eligible: true } | { eligible: false; why: string };

export function digitalAutoCompleteVerdict(input: AutoCompleteInput): AutoCompleteVerdict {
  if (input.items.length === 0) return { eligible: false, why: "no order items yet" };
  const physical = input.items.filter((i) => i.productType === "physical").length;
  if (physical > 0) {
    return { eligible: false, why: `${physical} physical line${physical === 1 ? "" : "s"} still ${physical === 1 ? "has" : "have"} to print and ship` };
  }
  if (input.printJobs > 0) return { eligible: false, why: "a print job exists for this order" };
  return { eligible: true };
}

export async function loadAutoCompleteInput(tx: Tx, orderId: string): Promise<AutoCompleteInput> {
  const [items, [jobs]] = await Promise.all([
    tx.select({ productType: orderItems.productType }).from(orderItems).where(eq(orderItems.orderId, orderId)),
    tx.select({ n: sql<number>`count(*)::int` }).from(printJobs).where(eq(printJobs.orderId, orderId)),
  ]);
  return { items, printJobs: jobs?.n ?? 0 };
}
