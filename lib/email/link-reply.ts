import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";

import type { Tx } from "@/lib/db";
import { customers, orders } from "@/lib/db/schema";
import { parseEmailAddress } from "./suppression";
import { extractOrderTokens } from "./outbox";

/**
 * Linking an inbound customer email to an order, shared by the Gmail poller
 * (automatic) and the Messages page "Link" button (by hand).
 *
 * Two jobs:
 *  1. matchOrderBySubject: a reply whose subject carries one of this business's
 *     order numbers ("Re: PC32164 ...", "#4170595372") is about that order. Open
 *     orders win over archived history; the newest wins a tie.
 *  2. adoptSenderAsCustomer: an order that has no customer yet (Etsy never gives
 *     us the buyer's email) takes the sender of a linked reply as its customer,
 *     so photo requests, proofs and replies can go out. The order row is only
 *     touched when it has no customer; an existing customer is never replaced.
 */

export type SubjectMatch = { orderId: string; customerId: string | null; status: string };

export async function matchOrderBySubject(
  tx: Tx,
  businessId: string,
  subject: string | null | undefined,
): Promise<SubjectMatch | null> {
  const tokens = extractOrderTokens(subject ?? "");
  if (!tokens.length) return null;
  const rows = await tx
    .select({
      id: orders.id,
      customerId: orders.customerId,
      status: orders.status,
      archivedAt: orders.archivedAt,
      createdAt: orders.createdAt,
    })
    .from(orders)
    .where(
      and(
        eq(orders.businessId, businessId),
        or(inArray(orders.platformOrderName, tokens), inArray(orders.platformOrderId, tokens)),
      ),
    )
    .orderBy(sql`${orders.archivedAt} is not null`, desc(orders.createdAt))
    .limit(1);
  const o = rows[0];
  return o ? { orderId: o.id, customerId: o.customerId, status: o.status } : null;
}

/** "Kate Keenan <k@x.com>" -> ["Kate", "Keenan"]; a bare address -> [null, null]. */
function senderName(fromHeader: string | null | undefined): [string | null, string | null] {
  const raw = (fromHeader ?? "").replace(/<[^>]*>/g, "").replace(/["']/g, "").trim();
  if (!raw || raw.includes("@")) return [null, null];
  const parts = raw.split(/\s+/);
  return [parts[0] ?? null, parts.slice(1).join(" ") || null];
}

/**
 * Give an order without a customer the sender of a linked reply. Returns the
 * customer id the order now has (existing or adopted), or null when nothing
 * could be adopted (no parseable sender).
 */
export async function adoptSenderAsCustomer(
  tx: Tx,
  args: { businessId: string; orderId: string; customerId: string | null; fromHeader: string | null | undefined },
): Promise<string | null> {
  if (args.customerId) return args.customerId;
  const email = parseEmailAddress(args.fromHeader ?? null);
  if (!email) return null;
  const [firstName, lastName] = senderName(args.fromHeader);
  await tx
    .insert(customers)
    .values({ businessId: args.businessId, email, firstName, lastName })
    .onConflictDoNothing({ target: [customers.businessId, customers.email] });
  const [c] = await tx
    .select({ id: customers.id })
    .from(customers)
    .where(and(eq(customers.businessId, args.businessId), eq(customers.email, email)));
  if (!c) return null;
  await tx
    .update(orders)
    .set({ customerId: c.id })
    .where(and(eq(orders.id, args.orderId), isNull(orders.customerId)));
  return c.id;
}
