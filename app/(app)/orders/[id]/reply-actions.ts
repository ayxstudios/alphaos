"use server";

// Reply drafting for the order card. Etsy has no messaging API — a VA copies
// the drafted text and pastes it into Etsy's own message thread by hand, then
// marks it sent here so the record lives on the order. Shopify/manual orders
// use the same panel for a quick ad-hoc note; only the real Gmail-gated proof
// flow (QC page, lib/email/dispatch.ts) actually sends mail from AlphaOS.
import { revalidatePath } from "next/cache";

import { eq } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { withUserContext, type RequestUser } from "@/lib/db";
import { activityLog, messages, orders } from "@/lib/db/schema";
import {
  renderReplyDraft,
  type ReplyTemplateChoice,
} from "@/lib/orders/reply-draft";

export type ReplyDraftResult =
  | { ok: true; subject: string; body: string }
  | { ok: false; message: string };

export type MarkReplySentResult = { ok: true } | { ok: false; message: string };

async function requireStaff(): Promise<RequestUser | null> {
  const session = await auth();
  if (!session?.user) return null;
  const role = session.user.role;
  if (role !== "admin" && role !== "va") return null;
  return { id: session.user.id, role };
}

export async function generateReplyDraft(orderId: string, key: ReplyTemplateChoice): Promise<ReplyDraftResult> {
  const user = await requireStaff();
  if (!user) return { ok: false, message: "Not permitted" };
  const rendered = await renderReplyDraft(user, orderId, key);
  if (!rendered) return { ok: false, message: "Order not found" };
  return { ok: true, ...rendered };
}

/** Record that a manually-copied reply was sent (pasted into Etsy, or ad hoc). */
export async function markReplySent(orderId: string, subject: string, body: string): Promise<MarkReplySentResult> {
  const user = await requireStaff();
  if (!user) return { ok: false, message: "Not permitted" };
  const text = body.trim();
  if (!text) return { ok: false, message: "Nothing to record" };

  const inserted = await withUserContext(user, async (tx) => {
    const [order] = await tx.select({ businessId: orders.businessId }).from(orders).where(eq(orders.id, orderId));
    if (!order) return null;
    const [row] = await tx
      .insert(messages)
      .values({
        businessId: order.businessId,
        orderId,
        direction: "outbound",
        channel: "email",
        status: "sent",
        subject: subject.trim() || null,
        body: text,
        sentAt: new Date(),
        approvedBy: user.id,
        manualSentAt: new Date(),
        manualSentBy: user.id,
        manualSentReason: "Copied and sent by hand (Etsy has no send API)",
      })
      .returning({ id: messages.id, businessId: messages.businessId });
    if (row) {
      await tx.insert(activityLog).values({
        businessId: row.businessId,
        orderId,
        actorId: user.id,
        action: "email.marked_sent_manually",
        metadata: { messageId: row.id, reason: "reply_draft_copy" },
      });
    }
    return row ?? null;
  });
  if (!inserted) return { ok: false, message: "Order not found" };

  revalidatePath(`/orders/${orderId}`);
  revalidatePath("/dashboard");
  revalidatePath("/orders");
  return { ok: true };
}
