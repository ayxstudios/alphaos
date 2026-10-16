// "Has the buyer said anything since the proof?" One answer for every road that
// chases a silent proof: the reminders sweep (3-day reminder, day-5 alert, day-7
// auto-approve), the agent inbox reminder and the send itself.
//
// Shelby Leachet 4199624202 (CPS) asked for changes by email at 20:31 on
// 2026-10-14; the reminders sweep sent her "please approve your proof" at 21:16
// because it only looked at the proof row, never at her reply (clean slating
// audit, 2026-10-16). A reply of any kind is not silence: a human or the
// proof-replies pass decides it, never a reminder.

import { and, desc, eq, gt, isNull, ne, or, sql } from "drizzle-orm";

import type { Tx } from "@/lib/db";
import { activityLog, messages, orders, proofs } from "@/lib/db/schema";

/** Inbound customer words on an order (email replies, Etsy conversation messages), not Etsy sale notices. */
export function buyerWordsWhere() {
  return and(
    eq(messages.direction, "inbound"),
    isNull(messages.suppressedAt),
    or(eq(messages.channel, "email"), and(eq(messages.channel, "etsy"), sql`${messages.metadata}->>'kind' = 'message'`)),
  );
}

/** True when the buyer wrote on this order after `since` (the proof going out). */
export async function buyerRepliedSince(tx: Tx, orderId: string, since: Date): Promise<boolean> {
  const [row] = await tx
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.orderId, orderId), buyerWordsWhere(), gt(messages.createdAt, since)))
    .limit(1);
  return !!row;
}

/**
 * Why a queued or drafted proof reminder must not go out, or null when it may:
 * the order left awaiting_approval, its latest proof was decided, or the buyer
 * wrote after that proof went out.
 */
export async function staleProofReminderReason(tx: Tx, orderId: string): Promise<string | null> {
  const [order] = await tx.select({ status: orders.status }).from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!order) return "the order is gone";
  if (order.status !== "awaiting_approval") return `the order is ${order.status.replace(/_/g, " ")}, not awaiting approval`;
  const [proof] = await tx
    .select({ decision: proofs.decision, at: sql<Date>`coalesce(${proofs.sentAt}, ${proofs.createdAt})`.mapWith((v) => new Date(v as string)) })
    .from(proofs)
    .where(eq(proofs.orderId, orderId))
    .orderBy(desc(proofs.createdAt))
    .limit(1);
  if (!proof) return "the order has no proof";
  if (proof.decision) return "the proof was already decided";
  if (await buyerRepliedSince(tx, orderId, proof.at)) return "the buyer replied after the proof";
  return null;
}

/**
 * Take a stale proof reminder out of every send road: archived (the outbox, the
 * send step and the retry step all skip archived rows), the reason on the row
 * and on the order's timeline. Never touches a row that already went out.
 */
export async function withdrawProofReminder(
  tx: Tx,
  msg: { id: string; businessId: string; orderId: string | null },
  reason: string,
): Promise<boolean> {
  const done = await tx
    .update(messages)
    .set({
      // Back to an archived draft, like a discarded one: the queued flush
      // (status queued) and the retry step (status failed) never see it again.
      status: "draft",
      archivedAt: new Date(),
      sendClaimedAt: null,
      metadata: sql`coalesce(${messages.metadata}, '{}'::jsonb) || ${JSON.stringify({ withdrawn: { at: new Date().toISOString(), reason } })}::jsonb`,
    })
    .where(and(eq(messages.id, msg.id), ne(messages.status, "sent"), isNull(messages.manualSentAt), isNull(messages.archivedAt)))
    .returning({ id: messages.id });
  if (!done.length) return false;
  await tx.insert(activityLog).values({
    businessId: msg.businessId,
    orderId: msg.orderId,
    actorId: null,
    action: "email.proof_reminder_withdrawn",
    metadata: { messageId: msg.id, reason },
  });
  return true;
}
