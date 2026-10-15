// Etsy review ask after a happy email (Yousif 2026-10-15: "for customers that are
// happy in cps Etsy, if they reply they are happy in emails they should still be
// prompted to leave a review on Etsy"). Mirrors the Etsy-chat rule the shop desks
// already follow: one warm ask, only to a buyer who is REALLY happy and whose
// portrait is COMPLETE, never for stars or a positive review, never anything in
// return, once per buyer ever, never to a buyer who is waiting or mid-revision.
//
// Complete for the buyer = a digital order approved (the proof email carries the
// high-resolution file, so approval is delivery) or a printed order that has
// shipped. The ask goes out as a queued email on the buyer's own thread, through
// the normal auto-send road (hourly cap, sending switch, signature). The
// once-per-buyer rule is held twice: an agent.review_asked activity row per
// customer, and the messages.dedupe_key `review-ask:<customer>` unique index.
import { and, eq, sql } from "drizzle-orm";

import type { Tx } from "@/lib/db";
import { activityLog, messages, orderItems } from "@/lib/db/schema";

import type { ReplyIntent } from "@/lib/email/reply-classifier";

export const REVIEW_ASK_ACTION = "agent.review_asked";

/** Order states in which the buyer already has what she paid for. */
const DIGITAL_DONE = new Set(["approved", "complete"]);
const PHYSICAL_DONE = new Set(["shipped", "delivered", "complete"]);

export type ReviewAskFacts = {
  source: string;
  /** Order status AFTER any decision from this reply was applied. */
  status: string;
  physical: boolean;
  happy: boolean;
  intent: ReplyIntent;
};

/** Pure gate: why this reply does not earn a review ask, or null when it does. */
export function reviewAskBlocker(f: ReviewAskFacts): string | null {
  if (f.source !== "etsy") return "not an Etsy order";
  if (!f.happy) return "buyer not clearly happy";
  if (f.intent === "revision_request") return "buyer asked for a change";
  if (f.intent === "question") return "buyer asked a question";
  const done = f.physical ? PHYSICAL_DONE : DIGITAL_DONE;
  if (!done.has(f.status)) return `order is ${f.status.replace(/_/g, " ")}, not complete for the buyer`;
  return null;
}

export function reviewAskBody(firstName: string, businessName: string): string {
  return [
    `Hi ${firstName},`,
    "",
    "So glad you love it! Thank you for letting us know, it truly made our day.",
    "",
    "If you have a moment, we would be so grateful if you shared your thoughts in a review on Etsy. You can find the order under Purchases and reviews in your Etsy account; it only takes a minute and means a lot to our small shop.",
    "",
    "Warmly,",
    `The ${businessName} team`,
  ].join("\n");
}

export async function orderHasPhysicalItem(tx: Tx, orderId: string): Promise<boolean> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(orderItems)
    .where(and(eq(orderItems.orderId, orderId), eq(orderItems.productType, "physical")));
  return Number(row?.n ?? 0) > 0;
}

export async function reviewAlreadyAsked(tx: Tx, businessId: string, customerId: string | null, orderId: string): Promise<boolean> {
  const who = customerId ?? orderId;
  const [row] = await tx
    .select({ id: activityLog.id })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.businessId, businessId),
        eq(activityLog.action, REVIEW_ASK_ACTION),
        sql`${activityLog.metadata}->>'who' = ${who}`,
      ),
    )
    .limit(1);
  return !!row;
}

/**
 * Queue the one review-ask email for this buyer. Returns the message id, or null
 * when she already had hers (or has no address). The caller decides eligibility
 * with reviewAskBlocker first.
 */
export async function queueReviewAsk(
  tx: Tx,
  input: {
    order: { id: string; businessId: string; customerId: string | null; platformOrderId: string; platformOrderName: string | null };
    ctx: { email: string; firstName: string; businessName: string };
    inReplyTo: { id: string; subject: string | null; gmailThreadId: string | null };
  },
): Promise<string | null> {
  const { order, ctx, inReplyTo } = input;
  const who = order.customerId ?? order.id;
  if (await reviewAlreadyAsked(tx, order.businessId, order.customerId, order.id)) return null;
  const orderNo = order.platformOrderName ?? order.platformOrderId;
  const subject = /^re:/i.test(inReplyTo.subject ?? "") ? inReplyTo.subject! : `Re: ${inReplyTo.subject || `Your order ${orderNo}`}`;
  const [row] = await tx
    .insert(messages)
    .values({
      businessId: order.businessId,
      orderId: order.id,
      customerId: order.customerId,
      direction: "outbound",
      channel: "email",
      status: "queued",
      subject,
      address: ctx.email,
      body: reviewAskBody(ctx.firstName, ctx.businessName),
      gmailThreadId: inReplyTo.gmailThreadId,
      dedupeKey: `review-ask:${who}`,
      metadata: { reviewAsk: true, replyToMessageId: inReplyTo.id, agentDrafted: true },
    })
    .onConflictDoNothing({ target: messages.dedupeKey, where: sql`${messages.dedupeKey} is not null` })
    .returning({ id: messages.id });
  if (!row?.id) return null;
  await tx.insert(activityLog).values({
    businessId: order.businessId,
    orderId: order.id,
    actorId: null,
    action: REVIEW_ASK_ACTION,
    metadata: { who, messageId: inReplyTo.id, outboundMessageId: row.id },
  });
  return row.id;
}
