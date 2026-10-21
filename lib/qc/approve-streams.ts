import { and, eq, inArray, gt } from "drizzle-orm";

import { withUserContext, type RequestUser } from "@/lib/db";
import { activityLog, orders } from "@/lib/db/schema";
import { SENT_BACK_FROM } from "@/lib/orders/board-constants";

/**
 * The three streams on /approve (both owners, 2026-10-21: "split the new orders and revisions into two different
 * streams", and the third, Cases, for customers who need a person: lib/cases/cards.ts).
 */
export type OrderStream = "new" | "revision";
export type Stream = OrderStream | "cases";

export const STREAMS: { key: Stream; label: string; short: string }[] = [
  { key: "new", label: "New orders", short: "New" },
  { key: "revision", label: "Revisions", short: "Revisions" },
  { key: "cases", label: "Cases", short: "Cases" },
];

export function parseStream(v: string | undefined): Stream | undefined {
  return v === "new" || v === "revision" || v === "cases" ? v : undefined;
}

/**
 * Which stream each queued order is in: a revision once it has been sent back to its designer at least once (the same test
 * the Approve screen labels it by: a revision count, or a send-back in the activity log).
 */
export async function getQueueKinds(user: RequestUser, ids: string[]): Promise<Map<string, OrderStream>> {
  const kinds = new Map<string, OrderStream>(ids.map((id) => [id, "new"]));
  if (!ids.length) return kinds;
  await withUserContext(user, async (tx) => {
    const counted = await tx.select({ id: orders.id }).from(orders).where(and(inArray(orders.id, ids), gt(orders.revisionCount, 0)));
    for (const r of counted) kinds.set(r.id, "revision");
    const sentBack = await tx
      .selectDistinct({ id: activityLog.orderId })
      .from(activityLog)
      .where(and(inArray(activityLog.orderId, ids), eq(activityLog.toState, "in_design"), inArray(activityLog.fromState, [...SENT_BACK_FROM])));
    for (const r of sentBack) if (r.id) kinds.set(r.id, "revision");
  });
  return kinds;
}
