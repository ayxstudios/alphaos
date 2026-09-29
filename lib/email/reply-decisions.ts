import { eq } from "drizzle-orm";

import { SYSTEM_ACTOR_ID, type RequestUser, type Tx } from "@/lib/db";
import { activityLog, messages, orders } from "@/lib/db/schema";
import { runTransition } from "@/lib/orders/transitions";

export type ReplyDecision = "approved" | "revision" | "dismissed";
/** The agent (lib/agent/inbox.ts) acting on a reply by itself. */
export type SystemReplyActor = { id: typeof SYSTEM_ACTOR_ID; role: "system" };
export type ReplyDecisionActor = RequestUser | SystemReplyActor;
export type ReplyDecisionOptions = {
  /** Replaces the default revision reason (the raw reply body). */
  revisionReason?: string;
  /** Transition metadata `via`; defaults to "reply_classification". */
  via?: string;
};
export type ReplyDecisionResult = { ok: true; message: string; orderId: string } | { ok: false; message: string; orderId?: string };

export async function applyReplyClassificationDecision(
  tx: Tx,
  user: ReplyDecisionActor,
  messageId: string,
  decision: ReplyDecision,
  opts: ReplyDecisionOptions = {},
): Promise<ReplyDecisionResult> {
  // A human keeps exactly the old behaviour. The system actor has no users row,
  // so actor/decidedBy columns get null and the decision is flagged as the agent's.
  const isSystem = user.role === "system";
  const actorId = isSystem ? null : user.id;
  const via = opts.via ?? "reply_classification";
  const [message] = await tx
    .select({
      id: messages.id,
      businessId: messages.businessId,
      orderId: messages.orderId,
      direction: messages.direction,
      body: messages.body,
      metadata: messages.metadata,
      orderStatus: orders.status,
    })
    .from(messages)
    .innerJoin(orders, eq(orders.id, messages.orderId))
    .where(eq(messages.id, messageId))
    .for("update")
    .limit(1);
  if (!message || message.direction !== "inbound" || !message.orderId) {
    return { ok: false, message: "Reply not found." };
  }

  const metadata = (message.metadata && typeof message.metadata === "object" && !Array.isArray(message.metadata)
    ? message.metadata
    : {}) as Record<string, unknown>;
  const classification = metadata.replyClassification && typeof metadata.replyClassification === "object"
    ? (metadata.replyClassification as Record<string, unknown>)
    : null;
  if (!classification) {
    return { ok: false, message: "This reply has no classification suggestion.", orderId: message.orderId };
  }
  if (message.orderStatus !== "awaiting_approval" && decision !== "dismissed") {
    return { ok: false, message: "This order is no longer awaiting approval.", orderId: message.orderId };
  }

  const vaDecision = {
    decision,
    decidedBy: actorId,
    ...(isSystem ? { decidedByAgent: true } : {}),
    decidedAt: new Date().toISOString(),
    agreedWithModel:
      decision === "approved"
        ? classification.intent === "approval"
        : decision === "revision"
          ? classification.intent === "revision_request"
          : false,
  };
  await tx.update(messages).set({
    metadata: {
      ...metadata,
      replyClassification: {
        ...classification,
        vaDecision,
      },
    },
  }).where(eq(messages.id, messageId));

  if (decision === "approved") {
    await runTransition(tx, user, {
      orderId: message.orderId,
      to: "approved",
      expectedFrom: "awaiting_approval",
      metadata: { via, messageId },
    });
  } else if (decision === "revision") {
    await runTransition(tx, user, {
      orderId: message.orderId,
      to: "in_design",
      expectedFrom: "awaiting_approval",
      metadata: {
        via,
        messageId,
        revisionReason: opts.revisionReason?.trim() || message.body?.trim() || "Customer requested a revision by email.",
      },
    });
  }

  await tx.insert(activityLog).values({
    businessId: message.businessId,
    orderId: message.orderId,
    actorId,
    action: "message.reply_classification_decided",
    metadata: {
      messageId,
      modelIntent: classification.intent,
      modelConfidence: classification.confidence,
      decision,
      agreedWithModel: vaDecision.agreedWithModel,
      ...(isSystem ? { decidedByAgent: true } : {}),
    },
  });
  return {
    ok: true,
    orderId: message.orderId,
    message:
      decision === "approved"
        ? "Order marked approved."
        : decision === "revision"
          ? "Order sent back to design."
          : "Suggestion dismissed.",
  };
}
