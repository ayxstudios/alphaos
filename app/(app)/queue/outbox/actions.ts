"use server";

import { revalidatePath } from "next/cache";
import { and, eq, inArray } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { withUserContext, type RequestUser } from "@/lib/db";
import { messages } from "@/lib/db/schema";
import { sendMessage } from "@/lib/email/dispatch";

export type OutboxActionResult =
  | { ok: true }
  | { ok: false; message: string };

async function requireVa(): Promise<RequestUser | { error: OutboxActionResult }> {
  const session = await auth();
  const role = session?.user?.role;
  if (!session?.user) return { error: { ok: false, message: "Not signed in" } };
  if (role !== "admin" && role !== "va") {
    return { error: { ok: false, message: "The outbox is VA/admin only" } };
  }
  return { id: session.user.id, role };
}

/**
 * The VA approval gate: persist the VA's edits to a draft, then send it via the
 * business's Gmail mailbox, stamping the VA as approver. Only acts on `draft` or
 * `failed` outbound rows the VA can see (RLS).
 */
export async function approveAndSend(input: {
  messageId: string;
  subject: string;
  body: string;
}): Promise<OutboxActionResult> {
  const auth = await requireVa();
  if ("error" in auth) return auth.error;

  const subject = input.subject.trim();
  const body = input.body.trim();
  if (!subject || !body) return { ok: false, message: "Subject and body are required" };

  // Persist edits first (staff can update messages under RLS). Guard the status
  // so we never re-send an already-sent row.
  const updated = await withUserContext(auth, (tx) =>
    tx
      .update(messages)
      .set({ subject, body })
      .where(
        and(
          eq(messages.id, input.messageId),
          eq(messages.direction, "outbound"),
          // draft or failed only — never re-touch an already-sent row.
          inArray(messages.status, ["draft", "failed"]),
        ),
      )
      .returning({ id: messages.id }),
  );
  if (!updated[0]) return { ok: false, message: "Draft not found or already sent." };

  const result = await sendMessage(input.messageId, { approvedById: auth.id });
  revalidatePath("/queue/outbox");
  revalidatePath("/queue");
  if (!result.ok) {
    return {
      ok: false,
      message: result.retryable
        ? `Couldn't send yet: ${result.error}. Connect Gmail in Settings, then retry.`
        : `Send failed: ${result.error}`,
    };
  }
  return { ok: true };
}

/** Discard a draft the VA does not want to send. */
export async function discardDraft(messageId: string): Promise<OutboxActionResult> {
  const auth = await requireVa();
  if ("error" in auth) return auth.error;

  await withUserContext(auth, (tx) =>
    tx
      .delete(messages)
      .where(
        and(
          eq(messages.id, messageId),
          eq(messages.direction, "outbound"),
          eq(messages.status, "draft"),
        ),
      ),
  );
  revalidatePath("/queue/outbox");
  revalidatePath("/queue");
  return { ok: true };
}
