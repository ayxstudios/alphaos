"use server";

import { revalidatePath } from "next/cache";
import { and, desc, eq, ilike, or } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { withUserContext, type RequestUser } from "@/lib/db";
import { activityLog, customers, messages, orders } from "@/lib/db/schema";
import { sendMessage } from "@/lib/email/dispatch";

export type OutboxActionResult = { ok: true; message?: string } | { ok: false; message: string };

async function requireStaff(): Promise<RequestUser | null> {
  const session = await auth();
  if (!session?.user) return null;
  const role = session.user.role;
  if (role !== "admin" && role !== "va") return null;
  return { id: session.user.id, role };
}

/** Edit a draft's body before it's approved. Draft/failed outbound only. */
export async function updateDraftBody(messageId: string, body: string): Promise<OutboxActionResult> {
  const user = await requireStaff();
  if (!user) return { ok: false, message: "Not permitted" };
  await withUserContext(user, (tx) =>
    tx
      .update(messages)
      .set({ body })
      .where(and(eq(messages.id, messageId), eq(messages.direction, "outbound"))),
  );
  revalidatePath("/orders");
  return { ok: true };
}

/**
 * Approve + send a draft. Goes through the gated send path (records
 * gmail_thread_id / gmail_message_id, sets approvedBy) and writes an
 * activity_log entry naming the approving VA. Surfaces the toggle-off reason.
 */
export async function approveAndSend(messageId: string): Promise<OutboxActionResult> {
  const user = await requireStaff();
  if (!user) return { ok: false, message: "Not permitted" };

  const meta = await withUserContext(user, async (tx) => {
    const [m] = await tx
      .select({ businessId: messages.businessId, orderId: messages.orderId, templateKey: messages.templateKey, address: messages.address })
      .from(messages)
      .where(and(eq(messages.id, messageId), eq(messages.direction, "outbound")));
    return m ?? null;
  });
  if (!meta) return { ok: false, message: "Message not found" };

  const res = await sendMessage(messageId, { approvedById: user.id });
  if (!res.ok) {
    // The safety rail returns a retryable "turned OFF" error — surface it plainly.
    return { ok: false, message: res.error ?? "Send failed" };
  }

  await withUserContext(user, (tx) =>
    tx.insert(activityLog).values({
      businessId: meta.businessId,
      orderId: meta.orderId,
      actorId: user.id,
      action: "email.sent",
      metadata: { messageId, templateKey: meta.templateKey, to: meta.address, approvedBy: user.id },
    }),
  );
  revalidatePath("/orders");
  revalidatePath("/dashboard");
  return { ok: true, message: "Email sent" };
}

/** Discard a draft that shouldn't go, with a required reason (kept for audit). */
export async function discardDraft(messageId: string, reasonRaw: string): Promise<OutboxActionResult> {
  const user = await requireStaff();
  if (!user) return { ok: false, message: "Not permitted" };
  const reason = reasonRaw.trim();
  if (!reason) return { ok: false, message: "A reason is required to discard" };

  return withUserContext(user, async (tx) => {
    const [m] = await tx
      .select({ businessId: messages.businessId, orderId: messages.orderId, status: messages.status })
      .from(messages)
      .where(and(eq(messages.id, messageId), eq(messages.direction, "outbound")));
    if (!m || m.status === "sent") return { ok: false as const, message: "Only unsent drafts can be discarded" };
    await tx.update(messages).set({ archivedAt: new Date() }).where(eq(messages.id, messageId));
    await tx.insert(activityLog).values({
      businessId: m.businessId,
      orderId: m.orderId,
      actorId: user.id,
      action: "email.discarded",
      metadata: { messageId, reason },
    });
    revalidatePath("/orders");
    revalidatePath("/dashboard");
    return { ok: true as const, message: "Draft discarded" };
  });
}

/** Search orders in a business by number, for the "link reply to order" picker. */
export async function searchOrdersForLink(
  businessId: string,
  q: string,
): Promise<{ orderId: string; orderNumber: string; customerName: string | null }[]> {
  const user = await requireStaff();
  if (!user) return [];
  const term = q.trim();
  if (term.length < 2) return [];
  return withUserContext(user, async (tx) => {
    const rows = await tx
      .select({
        id: orders.id,
        number: orders.platformOrderName,
        fallback: orders.platformOrderId,
        firstName: customers.firstName,
        lastName: customers.lastName,
      })
      .from(orders)
      .leftJoin(customers, eq(customers.id, orders.customerId))
      .where(
        and(
          eq(orders.businessId, businessId),
          or(ilike(orders.platformOrderName, `%${term}%`), ilike(orders.platformOrderId, `%${term}%`)),
        ),
      )
      .orderBy(desc(orders.createdAt))
      .limit(10);
    return rows.map((r) => ({
      orderId: r.id,
      orderNumber: r.number ?? r.fallback ?? "—",
      customerName: [r.firstName, r.lastName].filter(Boolean).join(" ") || null,
    }));
  });
}

/** Link an unmatched reply to an order: attaches it and drops it on the timeline. */
export async function linkReplyToOrder(messageId: string, orderId: string): Promise<OutboxActionResult> {
  const user = await requireStaff();
  if (!user) return { ok: false, message: "Not permitted" };
  return withUserContext(user, async (tx) => {
    const [m] = await tx
      .select({ id: messages.id, businessId: messages.businessId, subject: messages.subject, address: messages.address })
      .from(messages)
      .where(and(eq(messages.id, messageId), eq(messages.direction, "inbound")));
    if (!m) return { ok: false as const, message: "Reply not found" };
    const [o] = await tx
      .select({ id: orders.id, businessId: orders.businessId, customerId: orders.customerId })
      .from(orders)
      .where(eq(orders.id, orderId));
    if (!o || o.businessId !== m.businessId) return { ok: false as const, message: "Order not found in this workspace" };

    await tx.update(messages).set({ orderId: o.id, customerId: o.customerId }).where(eq(messages.id, messageId));
    await tx.insert(activityLog).values({
      businessId: m.businessId,
      orderId: o.id,
      actorId: user.id,
      action: "message.received",
      metadata: { channel: "email", subject: m.subject, from: m.address, manuallyLinkedBy: user.id },
    });
    revalidatePath("/orders");
    revalidatePath("/dashboard");
    revalidatePath(`/orders/${o.id}`);
    return { ok: true as const, message: "Reply linked to order" };
  });
}

/** Archive an unmatched reply (spam / not a customer / handled), reason required. */
export async function archiveReply(messageId: string, reasonRaw: string): Promise<OutboxActionResult> {
  const user = await requireStaff();
  if (!user) return { ok: false, message: "Not permitted" };
  const reason = reasonRaw.trim();
  if (!reason) return { ok: false, message: "A reason is required to archive" };
  return withUserContext(user, async (tx) => {
    const [m] = await tx
      .select({ businessId: messages.businessId, address: messages.address, subject: messages.subject })
      .from(messages)
      .where(and(eq(messages.id, messageId), eq(messages.direction, "inbound")));
    if (!m) return { ok: false as const, message: "Reply not found" };
    await tx.update(messages).set({ archivedAt: new Date() }).where(eq(messages.id, messageId));
    await tx.insert(activityLog).values({
      businessId: m.businessId,
      orderId: null,
      actorId: user.id,
      action: "message.archived",
      metadata: { messageId, from: m.address, subject: m.subject, reason },
    });
    revalidatePath("/orders");
    revalidatePath("/dashboard");
    return { ok: true as const, message: "Reply archived" };
  });
}
