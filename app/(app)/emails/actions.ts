"use server";

import { revalidatePath } from "next/cache";
import { and, eq, inArray, sql } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { withUserContext, type RequestUser } from "@/lib/db";
import { activityLog, customers, emailSenderIgnores, messages, orders } from "@/lib/db/schema";
import { notifyVaEmailFailure, sendMessage } from "@/lib/email/dispatch";
import { ignoreMatchesAddress, parseEmailAddress } from "@/lib/email/suppression";
import {
  approveAndSend,
  archiveReply,
  discardDraft,
  linkReplyToOrder,
  markEmailSentManually,
  searchOrdersForLink,
  updateDraftBody,
  type OutboxActionResult,
} from "@/app/(app)/orders/outbox-actions";

export {
  approveAndSend,
  archiveReply,
  discardDraft,
  linkReplyToOrder,
  markEmailSentManually,
  searchOrdersForLink,
  updateDraftBody,
};
export type { OutboxActionResult };

async function requireStaff(): Promise<RequestUser | null> {
  const session = await auth();
  if (!session?.user) return null;
  const role = session.user.role;
  if (role !== "admin" && role !== "va") return null;
  return { id: session.user.id, role };
}

function clean(value: string | null | undefined): string {
  return (value ?? "").trim();
}

export async function sendComposedEmail(input: {
  businessId: string;
  to: string;
  subject: string;
  body: string;
  orderId?: string | null;
  customerId?: string | null;
  replyToMessageId?: string | null;
}): Promise<OutboxActionResult> {
  const user = await requireStaff();
  if (!user) return { ok: false, message: "Not permitted" };

  const to = parseEmailAddress(input.to);
  const subject = clean(input.subject);
  const body = clean(input.body);
  if (!to) return { ok: false, message: "A valid recipient email is required" };
  if (!subject) return { ok: false, message: "Subject is required" };
  if (!body) return { ok: false, message: "Body is required" };

  const created = await withUserContext(user, async (tx) => {
    let businessId = input.businessId;
    let orderId = input.orderId ?? null;
    let customerId = input.customerId ?? null;
    let gmailThreadId: string | null = null;

    if (input.replyToMessageId) {
      const [source] = await tx
        .select({
          id: messages.id,
          businessId: messages.businessId,
          orderId: messages.orderId,
          customerId: messages.customerId,
          gmailThreadId: messages.gmailThreadId,
        })
        .from(messages)
        .where(eq(messages.id, input.replyToMessageId))
        .limit(1);
      if (!source) return { ok: false as const, message: "Message to reply to was not found" };
      businessId = source.businessId;
      orderId = orderId ?? source.orderId;
      customerId = customerId ?? source.customerId;
      gmailThreadId = source.gmailThreadId;
    }

    if (orderId) {
      const [order] = await tx
        .select({ id: orders.id, businessId: orders.businessId, customerId: orders.customerId })
        .from(orders)
        .where(eq(orders.id, orderId))
        .limit(1);
      if (!order || order.businessId !== businessId) return { ok: false as const, message: "Order not found in this workspace" };
      customerId = customerId ?? order.customerId;
    }

    if (customerId) {
      const [customer] = await tx
        .select({ id: customers.id, businessId: customers.businessId })
        .from(customers)
        .where(eq(customers.id, customerId))
        .limit(1);
      if (!customer || customer.businessId !== businessId) {
        return { ok: false as const, message: "Customer not found in this workspace" };
      }
    }

    const [row] = await tx
      .insert(messages)
      .values({
        businessId,
        orderId,
        customerId,
        direction: "outbound",
        channel: "email",
        status: "draft",
        subject,
        address: to,
        body,
        gmailThreadId,
        metadata: {
          composedInApp: true,
          replyToMessageId: input.replyToMessageId ?? null,
          previewConfirmedAt: new Date().toISOString(),
        },
      })
      .returning({ id: messages.id, businessId: messages.businessId, orderId: messages.orderId });

    await tx.insert(activityLog).values({
      businessId,
      orderId,
      actorId: user.id,
      action: "email.composed",
      metadata: { messageId: row.id, to, subject, replyToMessageId: input.replyToMessageId ?? null },
    });
    return { ok: true as const, messageId: row.id, businessId: row.businessId, orderId: row.orderId };
  });

  if (!created.ok) return created;

  const sent = await sendMessage(created.messageId, { approvedById: user.id, markRetryableFailed: true });
  if (!sent.ok) {
    await withUserContext(user, async (tx) => {
      await notifyVaEmailFailure(tx, {
        businessId: created.businessId,
        orderId: created.orderId,
        messageId: created.messageId,
        error: sent.error,
      });
      await tx.insert(activityLog).values({
        businessId: created.businessId,
        orderId: created.orderId,
        actorId: user.id,
        action: "email.send_failed",
        metadata: { messageId: created.messageId, to, subject, error: sent.error },
      });
    });
    revalidateEmailSurfaces(created.orderId, input.customerId ?? null);
    return { ok: false, message: sent.error };
  }

  await withUserContext(user, (tx) =>
    tx.insert(activityLog).values({
      businessId: created.businessId,
      orderId: created.orderId,
      actorId: user.id,
      action: "email.sent",
      metadata: { messageId: created.messageId, to, subject, composedInApp: true },
    }),
  );
  revalidateEmailSurfaces(created.orderId, input.customerId ?? null);
  return { ok: true, message: "Email sent" };
}

export async function ignoreSenderFromMessage(messageId: string): Promise<OutboxActionResult> {
  const user = await requireStaff();
  if (!user) return { ok: false, message: "Not permitted" };

  return withUserContext(user, async (tx) => {
    const [message] = await tx
      .select({ businessId: messages.businessId, address: messages.address })
      .from(messages)
      .where(and(eq(messages.id, messageId), eq(messages.direction, "inbound")))
      .limit(1);
    const value = parseEmailAddress(message?.address ?? null);
    if (!message || !value) return { ok: false as const, message: "Sender address not found" };

    const [existing] = await tx
      .select({ id: emailSenderIgnores.id })
      .from(emailSenderIgnores)
      .where(and(eq(emailSenderIgnores.businessId, message.businessId), sql`lower(${emailSenderIgnores.value}) = ${value}`))
      .limit(1);
    if (existing) {
      await tx
        .update(emailSenderIgnores)
        .set({ active: true })
        .where(eq(emailSenderIgnores.id, existing.id));
    } else {
      await tx.insert(emailSenderIgnores).values({
        businessId: message.businessId,
        value,
        matchType: "email",
        createdBy: user.id,
      });
    }

    await tx
      .update(messages)
      .set({ suppressedAt: new Date(), suppressedReason: `Ignored sender: ${value}` })
      .where(and(eq(messages.businessId, message.businessId), eq(messages.direction, "inbound"), sql`lower(${messages.address}) like ${`%${value}%`}`));

    await tx.insert(activityLog).values({
      businessId: message.businessId,
      orderId: null,
      actorId: user.id,
      action: "email.sender_ignored",
      metadata: { value },
    });
    revalidatePath("/emails");
    revalidatePath("/dashboard");
    return { ok: true as const, message: "Sender ignored" };
  });
}

export async function unsuppressMessage(messageId: string): Promise<OutboxActionResult> {
  const user = await requireStaff();
  if (!user) return { ok: false, message: "Not permitted" };
  return withUserContext(user, async (tx) => {
    const [row] = await tx
      .update(messages)
      .set({ suppressedAt: null, suppressedReason: null })
      .where(and(eq(messages.id, messageId), eq(messages.direction, "inbound")))
      .returning({ businessId: messages.businessId, orderId: messages.orderId });
    if (!row) return { ok: false as const, message: "Message not found" };
    await tx.insert(activityLog).values({
      businessId: row.businessId,
      orderId: row.orderId,
      actorId: user.id,
      action: "email.unsuppressed",
      metadata: { messageId },
    });
    revalidatePath("/emails");
    revalidatePath("/dashboard");
    return { ok: true as const, message: "Message restored" };
  });
}

export async function removeIgnoredSender(ignoreId: string): Promise<OutboxActionResult> {
  const user = await requireStaff();
  if (!user) return { ok: false, message: "Not permitted" };
  return withUserContext(user, async (tx) => {
    const [ignore] = await tx
      .select({
        id: emailSenderIgnores.id,
        businessId: emailSenderIgnores.businessId,
        value: emailSenderIgnores.value,
        matchType: emailSenderIgnores.matchType,
      })
      .from(emailSenderIgnores)
      .where(eq(emailSenderIgnores.id, ignoreId))
      .limit(1);
    if (!ignore) return { ok: false as const, message: "Ignored sender not found" };
    await tx.update(emailSenderIgnores).set({ active: false }).where(eq(emailSenderIgnores.id, ignore.id));

    const inbound = await tx
      .select({ id: messages.id, address: messages.address })
      .from(messages)
      .where(and(eq(messages.businessId, ignore.businessId), eq(messages.direction, "inbound"), sql`${messages.suppressedReason} like ${`%${ignore.value}%`}`));
    const restoreIds = inbound.filter((m) => ignoreMatchesAddress(ignore, m.address)).map((m) => m.id);
    if (restoreIds.length) {
      await tx
        .update(messages)
        .set({ suppressedAt: null, suppressedReason: null })
        .where(inArray(messages.id, restoreIds));
    }

    await tx.insert(activityLog).values({
      businessId: ignore.businessId,
      orderId: null,
      actorId: user.id,
      action: "email.sender_unignored",
      metadata: { value: ignore.value, restoredMessages: restoreIds.length },
    });
    revalidatePath("/emails");
    revalidatePath("/dashboard");
    return { ok: true as const, message: "Sender restored" };
  });
}

function revalidateEmailSurfaces(orderId: string | null, customerId: string | null) {
  revalidatePath("/emails");
  revalidatePath("/dashboard");
  if (orderId) revalidatePath(`/orders/${orderId}`);
  if (customerId) revalidatePath(`/customers/${customerId}`);
}
