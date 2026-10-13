import { and, asc, eq } from "drizzle-orm";

import { withUserContext, type RequestUser } from "@/lib/db";
import { activityLog, orders, shops, users } from "@/lib/db/schema";
import type { CardEvent } from "@/lib/orders/card-detail";
import { buildRevisionHistory, type RevisionHistoryNote } from "@/lib/orders/revision-history";
import type { OrderStatus } from "@/lib/orders/transitions";
import { getAutoQcView, latestSlots, slotAssetIds, type AutoQcView } from "./auto-qc";
import { getQcContext, getQcQueueIds, type QcContext } from "./data";

/**
 * The owner Approve screen (/approve, 2026-10-14): from 14 Oct there are no
 * VAs, so the owners QC designer work themselves, one order at a time, with
 * two buttons. This is the QC context plus the two things that screen leads
 * with: is it a NEW ORDER or a REVISION, and what was asked for.
 */
export type ApproveItem = {
  ctx: QcContext;
  shopName: string;
  urgent: boolean;
  urgentReason: string | null;
  /** True once the order has been sent back to the designer at least once. */
  isRevision: boolean;
  /** Which round this is (1 = first redo). */
  round: number;
  /** Every change request, newest first (customer, team or a failed QC). */
  requests: RevisionHistoryNote[];
  /** The newest Auto QC on this order (2026-10-14), or null when none yet. */
  autoQc: AutoQcView | null;
};

export async function getApproveQueue(user: RequestUser): Promise<string[]> {
  // One queue across every business the owner can see.
  return getQcQueueIds(user, "all");
}

export async function getApproveItem(user: RequestUser, orderId: string): Promise<ApproveItem | null> {
  const ctx = await getQcContext(user, orderId);
  if (!ctx) return null;
  const extra = await withUserContext(user, async (tx) => {
    const [o] = await tx
      .select({
        revisionCount: orders.revisionCount,
        urgentAt: orders.urgentAt,
        urgentReason: orders.urgentReason,
        shopName: shops.name,
      })
      .from(orders)
      .innerJoin(shops, eq(shops.id, orders.shopId))
      .where(eq(orders.id, orderId));
    const rows = await tx
      .select({
        id: activityLog.id,
        action: activityLog.action,
        actorId: activityLog.actorId,
        actorName: users.name,
        fromState: activityLog.fromState,
        toState: activityLog.toState,
        metadata: activityLog.metadata,
        createdAt: activityLog.createdAt,
      })
      .from(activityLog)
      .leftJoin(users, eq(users.id, activityLog.actorId))
      .where(and(eq(activityLog.orderId, orderId), eq(activityLog.toState, "in_design")))
      .orderBy(asc(activityLog.createdAt));
    const events: CardEvent[] = rows.map((r) => ({
      id: r.id,
      action: r.action,
      actorId: r.actorId,
      actorName: r.actorName ?? null,
      fromState: (r.fromState as OrderStatus | null) ?? null,
      toState: (r.toState as OrderStatus | null) ?? null,
      body: null,
      metadata: (r.metadata as Record<string, unknown> | null) ?? null,
      createdAt: r.createdAt.toISOString(),
    }));
    const autoQc = await getAutoQcView(tx, orderId, slotAssetIds(latestSlots(ctx.versions, ctx.portraits)));
    return { o, requests: buildRevisionHistory(events), autoQc };
  });
  const revisionCount = extra.o?.revisionCount ?? 0;
  const isRevision = revisionCount > 0 || extra.requests.length > 0;
  return {
    ctx,
    shopName: extra.o?.shopName ?? "",
    urgent: !!extra.o?.urgentAt,
    urgentReason: extra.o?.urgentAt ? (extra.o.urgentReason ?? null) : null,
    isRevision,
    round: Math.max(revisionCount, extra.requests.length, isRevision ? 1 : 0),
    requests: extra.requests,
    autoQc: extra.autoQc,
  };
}
