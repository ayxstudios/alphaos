import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { withSystemContext, withUserContext, type RequestUser } from "@/lib/db";
import { activityLog, assets, businesses, messages, orderItems, orders, proofs } from "@/lib/db/schema";
import { liveOrderWhere } from "@/lib/orders/archive";
import { transition } from "@/lib/orders/transitions";
import { resolveUrl, type DayImage } from "@/lib/agent/day";

/** One "AI portrait ready" card for the Day queue (admins only). */
export type OwnerReviewCard = {
  orderId: string;
  orderNumber: string;
  businessId: string;
  businessName: string;
  waitingSince: string;
  productLine: string;
  buyerNotes: string | null;
  buyerPhotos: DayImage[];
  portrait: DayImage | null;
  selfCheck: string | null;
};

export async function getOwnerReviewCards(user: RequestUser, businessScope: string | null): Promise<OwnerReviewCard[]> {
  if (user.role !== "admin") return [];
  return withUserContext(user, async (tx) => {
    const scoped = businessScope && businessScope !== "all" ? eq(orders.businessId, businessScope) : undefined;
    const rows = await tx
      .select({
        id: orders.id,
        number: orders.platformOrderName,
        fallback: orders.platformOrderId,
        businessId: orders.businessId,
        businessName: businesses.name,
        notes: orders.notes,
        updatedAt: orders.updatedAt,
      })
      .from(orders)
      .innerJoin(businesses, eq(businesses.id, orders.businessId))
      .where(and(eq(orders.aiState, "owner_review"), liveOrderWhere(), scoped))
      .orderBy(asc(orders.updatedAt))
      .limit(100);
    const out: OwnerReviewCard[] = [];
    for (const r of rows) {
      const [item] = await tx
        .select({ title: orderItems.title, options: orderItems.options, style: orderItems.style })
        .from(orderItems)
        .where(eq(orderItems.orderId, r.id))
        .orderBy(asc(orderItems.id))
        .limit(1);
      const size = Array.isArray(item?.options)
        ? (item.options as Array<{ name?: string; value?: string }>).find((o) => /size|dimension/i.test(o?.name ?? ""))?.value
        : null;
      const refs = await tx
        .select({ id: assets.id, url: assets.url, storage: assets.storage, r2Key: assets.r2Key })
        .from(assets)
        .where(and(eq(assets.orderId, r.id), eq(assets.type, "reference"), isNull(assets.deletedAt)))
        .orderBy(asc(assets.createdAt));
      const [latest] = await tx
        .select({ id: assets.id, url: assets.url, storage: assets.storage, r2Key: assets.r2Key })
        .from(assets)
        .where(and(eq(assets.orderId, r.id), inArray(assets.type, ["submission", "final"]), isNull(assets.deletedAt)))
        .orderBy(desc(assets.createdAt))
        .limit(1);
      const [delivered] = await tx
        .select({ meta: activityLog.metadata })
        .from(activityLog)
        .where(and(eq(activityLog.orderId, r.id), eq(activityLog.action, "ai.delivered")))
        .orderBy(desc(activityLog.createdAt))
        .limit(1);
      out.push({
        orderId: r.id,
        orderNumber: r.number ?? r.fallback,
        businessId: r.businessId,
        businessName: r.businessName,
        waitingSince: r.updatedAt.toISOString(),
        productLine: [item?.title ?? "Portrait", size, item?.style].filter(Boolean).join(" / "),
        buyerNotes: r.notes?.trim() || null,
        buyerPhotos: await Promise.all(refs.map(async (a) => ({ id: a.id, url: await resolveUrl(a) }))),
        portrait: latest ? { id: latest.id, url: await resolveUrl(latest) } : null,
        selfCheck: ((delivered?.meta ?? {}) as { selfCheck?: string }).selfCheck ?? null,
      });
    }
    return out;
  });
}

export type SendBackResult = { ok: true } | { ok: false; message: string };

/**
 * The owner says an AI portrait needs a fix before it goes out. The held proof
 * email is dropped (the buyer never saw it), the proof is closed as a revision
 * with the owner's words, and the order goes back to the AI revision queue
 * through the normal revision edge (which re-queues the agent, not a human).
 */
export async function sendOwnerReviewBackToAi(user: RequestUser, orderId: string, reason: string): Promise<SendBackResult> {
  const held = await withSystemContext(async (tx) => {
    const [o] = await tx
      .select({ businessId: orders.businessId, aiState: orders.aiState, status: orders.status })
      .from(orders)
      .where(eq(orders.id, orderId))
      .for("update");
    if (!o || o.aiState !== "owner_review" || o.status !== "awaiting_approval") return null;
    const [draft] = await tx
      .select({ id: messages.id, proofId: messages.proofId })
      .from(messages)
      .where(
        and(
          eq(messages.orderId, orderId),
          eq(messages.direction, "outbound"),
          eq(messages.status, "draft"),
          sql`${messages.metadata} ? 'qcPass'`,
        ),
      )
      .orderBy(desc(messages.createdAt))
      .limit(1);
    if (draft) await tx.delete(messages).where(eq(messages.id, draft.id));
    const [proof] = draft?.proofId
      ? [{ id: draft.proofId }]
      : await tx.select({ id: proofs.id }).from(proofs).where(eq(proofs.orderId, orderId)).orderBy(desc(proofs.createdAt)).limit(1);
    if (proof) {
      await tx
        .update(proofs)
        .set({ decision: "revision", decidedAt: new Date(), revisionNotes: reason, failedItems: [] })
        .where(and(eq(proofs.id, proof.id), isNull(proofs.decidedAt)));
    }
    await tx.insert(activityLog).values({
      businessId: o.businessId,
      orderId,
      actorId: user.id,
      action: "ai.owner_fix_requested",
      metadata: { reason },
    });
    return o;
  });
  if (!held) return { ok: false, message: "This portrait is no longer waiting for your approval." };
  await transition(user, {
    orderId,
    to: "in_design",
    expectedFrom: "awaiting_approval",
    metadata: { via: "owner_review_fix", revisionReason: reason },
  });
  return { ok: true };
}
