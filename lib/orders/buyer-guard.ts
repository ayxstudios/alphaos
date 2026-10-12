import { and, desc, eq, ne } from "drizzle-orm";

import type { Tx } from "@/lib/db";
import { customers, orders } from "@/lib/db/schema";
import { buyerMismatchMessage, joinCustomerName, namesMatch } from "@/lib/orders/buyer-match";

/**
 * The database half of the buyer check: would attaching this email (and the
 * name typed with it) to an order put someone other than the receipt buyer on
 * it? Shared by "complete order details" and "link a reply to an order".
 * Read only; the caller decides whether a person may override the answer.
 */

export type BuyerMismatch = {
  receiptBuyer: string;
  /** The name on the details being attached: the typed one, else the existing customer's. */
  enteredName: string;
  email: string;
  /** Ready to show a VA: both people, the email, the other order. */
  message: string;
};

export async function findBuyerMismatch(
  tx: Tx,
  args: {
    businessId: string;
    orderId: string;
    /** The order's current customer. Saving that same customer again attaches nobody new. */
    orderCustomerId: string | null;
    /** Lower-cased email being linked. */
    email: string;
    /** The name typed (or taken from a sender) with the email; may be empty. */
    typedName?: string | null;
    /** Who the receipt says bought the order; null means nothing to check against. */
    receiptBuyer: string | null;
    /** Name of the button that overrides the refusal, for the message. Default "Save anyway". */
    overrideLabel?: string;
  },
): Promise<BuyerMismatch | null> {
  const receiptBuyer = args.receiptBuyer?.trim();
  if (!receiptBuyer) return null;
  const typedName = args.typedName?.trim() ?? "";

  // The customer row this email already has. Customers are unique per business
  // and email, and an existing row keeps its name: linking the email links that
  // person, whatever name was typed.
  const [existing] = await tx
    .select({ id: customers.id, firstName: customers.firstName, lastName: customers.lastName })
    .from(customers)
    .where(and(eq(customers.businessId, args.businessId), eq(customers.email, args.email)));
  const existingName = existing ? joinCustomerName(existing.firstName, existing.lastName) : "";

  // Saving the order's own customer again, name unchanged, links nobody new.
  if (
    existing &&
    existing.id === args.orderCustomerId &&
    (!typedName || namesMatch(typedName, existingName) !== "mismatch")
  ) {
    return null;
  }

  const typedWrong = !!typedName && namesMatch(typedName, receiptBuyer) === "mismatch";
  const existingWrong = !!existingName && namesMatch(existingName, receiptBuyer) === "mismatch";
  if (!typedWrong && !existingWrong) return null;

  let otherOrderNumber: string | null = null;
  if (existing) {
    const [other] = await tx
      .select({ number: orders.platformOrderName })
      .from(orders)
      .where(and(eq(orders.customerId, existing.id), ne(orders.id, args.orderId)))
      .orderBy(desc(orders.createdAt))
      .limit(1);
    otherOrderNumber = other?.number ?? null;
  }

  const enteredName = typedWrong ? typedName : existingName;
  return {
    receiptBuyer,
    enteredName,
    email: args.email,
    message: buyerMismatchMessage({
      receiptBuyer,
      otherName: enteredName,
      otherEmail: args.email,
      otherOrderNumber,
      overrideLabel: args.overrideLabel,
    }),
  };
}
