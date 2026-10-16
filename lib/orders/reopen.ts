// A buyer writing about an archived order reopens it (clean slating audit,
// 2026-10-16, deck af027ad3beb2831a): Nancy Lane PC32186 asked "has my order
// shipped?" on 2026-10-16 about an order archived in the "pre 2026-10-03"
// sweep, and ten more archived-but-owed orders had buyer mail after their
// archive date, all invisible to every live board and check. A buyer writing
// means the order is live.
//
// Reopening only clears the archive (back on the boards, in the census, in the
// overdue numbers) and writes the timeline row. It never marks the order
// urgent: urgent pulls a legacy order into the agent's scope, which can send
// that buyer automatic mail (a photo-shortfall ask) about an order the old
// process may already have finished. Urgency stays a person's or the agent's
// call (order-whereis on the agent side). No buyer is written to from here.
import { and, eq, isNotNull, sql } from "drizzle-orm";

import { withSystemContext, type Tx } from "@/lib/db";
import { activityLog, messages, orders } from "@/lib/db/schema";
import { buyerWordsWhere } from "@/lib/reminders/buyer-replied";

import { archivedUnfinishedWhere, ARCHIVE_FINISHED_STATUSES, isSettledArchiveReason } from "./archive";

export type ReopenVia = "email" | "etsy" | "tick";

export type ReopenResult =
  | { reopened: true }
  | { reopened: false; why: "not_archived" | "finished" | "settled" | "missing" };

/**
 * Called right after a buyer message lands on an order. Clears the archive when
 * the order is archived and still owed; a no-op otherwise.
 */
export async function reopenArchivedOnBuyerWords(
  tx: Tx,
  input: { orderId: string; messageId: string | null; via: ReopenVia },
): Promise<ReopenResult> {
  const [o] = await tx
    .select({
      businessId: orders.businessId,
      status: orders.status,
      archivedAt: orders.archivedAt,
      archiveReason: orders.archiveReason,
    })
    .from(orders)
    .where(eq(orders.id, input.orderId))
    .limit(1)
    .for("update");
  if (!o) return { reopened: false, why: "missing" };
  if (!o.archivedAt) return { reopened: false, why: "not_archived" };
  if ((ARCHIVE_FINISHED_STATUSES as readonly string[]).includes(o.status)) return { reopened: false, why: "finished" };
  if (isSettledArchiveReason(o.archiveReason)) return { reopened: false, why: "settled" };

  const done = await tx
    .update(orders)
    .set({ archivedAt: null, archiveReason: null })
    .where(and(eq(orders.id, input.orderId), isNotNull(orders.archivedAt)))
    .returning({ id: orders.id });
  if (!done.length) return { reopened: false, why: "not_archived" };
  await tx.insert(activityLog).values({
    businessId: o.businessId,
    orderId: input.orderId,
    actorId: null,
    action: "order.reopened_by_buyer",
    metadata: {
      messageId: input.messageId,
      via: input.via,
      archivedAt: new Date(o.archivedAt).toISOString(),
      archiveReason: o.archiveReason,
    },
  });
  return { reopened: true };
}

export type ReopenSweepResult = {
  /** Archived, still-owed orders with buyer words after their archive date. */
  found: number;
  reopened: { id: string; number: string }[];
  /** Archived on purpose with a settled reason: left for a person. */
  keptSettled: number;
};

/**
 * Tick catch-all: buyer words that reached an archived order some other way (a
 * VA linking the mail by hand, mail that landed before this check existed).
 * Only words newer than the archive count, so an order a person archives after
 * reading the buyer stays archived.
 */
export async function reopenArchivedWithBuyerWords(
  businessId: string,
  opts: { dryRun?: boolean; limit?: number } = {},
): Promise<ReopenSweepResult> {
  return withSystemContext(async (tx) => {
    const rows = await tx
      .select({
        id: orders.id,
        name: orders.platformOrderName,
        platformOrderId: orders.platformOrderId,
        archiveReason: orders.archiveReason,
        // Table names spelled out: drizzle leaves columns unqualified in the
        // select list of a single-table query, which would bind them to messages.
        messageId: sql<string | null>`(select messages.id from messages
          where messages.order_id = orders.id and ${buyerWordsWhere()} and messages.created_at > orders.archived_at
          order by messages.created_at desc limit 1)`,
      })
      .from(orders)
      .where(
        and(
          eq(orders.businessId, businessId),
          archivedUnfinishedWhere(),
          sql`exists (select 1 from ${messages} where ${messages.orderId} = ${orders.id}
            and ${buyerWordsWhere()} and ${messages.createdAt} > ${orders.archivedAt})`,
        ),
      )
      .limit(opts.limit ?? 200);
    const res: ReopenSweepResult = { found: rows.length, reopened: [], keptSettled: 0 };
    for (const r of rows) {
      if (isSettledArchiveReason(r.archiveReason)) {
        res.keptSettled++;
        continue;
      }
      if (opts.dryRun) {
        res.reopened.push({ id: r.id, number: r.name ?? r.platformOrderId });
        continue;
      }
      const out = await reopenArchivedOnBuyerWords(tx, { orderId: r.id, messageId: r.messageId, via: "tick" });
      if (out.reopened) res.reopened.push({ id: r.id, number: r.name ?? r.platformOrderId });
    }
    return res;
  });
}
