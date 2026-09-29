import { and, desc, eq, isNotNull, isNull, ne, sql } from "drizzle-orm";

import { getAgentConfig } from "@/lib/agent/config";
import { withSystemContext, type Tx } from "@/lib/db";
import { businesses, customers, messages, notifications, proofs, users } from "@/lib/db/schema";
import { GmailClient, GmailNotConnectedError, GmailReauthRequiredError } from "@/lib/integrations/gmail";
import { header } from "@/lib/integrations/gmail/mime";
import { loadAssetAttachment } from "@/lib/email/attachments";
import { generateProofToken } from "@/lib/proofs/tokens";
import { proofUrl, uploadUrl } from "@/lib/urls";
import {
  DEFAULT_TEMPLATES,
  renderTemplate,
  resolveTemplate,
  type TemplateKey,
  type TemplateVars,
} from "./templates";

/**
 * Outbound customer email. Every message is a `messages` row first; sending is a
 * separate step. The approval gate lives here in the DATA: staff-drafted email is
 * inserted as `draft` and waits in the VA outbox; the two auto-send exceptions
 * (photo request on import, 48h reminder) are inserted as `queued` and sent by a
 * flush without VA review. See CLAUDE.md ("customer-facing email is drafted,
 * previewed, and approved by a VA before sending").
 */

type EmailContext = { businessName: string; firstName: string; email: string } | null;

/** Read the business name + customer first name/email needed to render a template. */
async function readEmailContext(
  tx: Tx,
  businessId: string,
  customerId: string | null,
): Promise<EmailContext> {
  if (!customerId) return null;
  const [biz] = await tx
    .select({ name: businesses.name })
    .from(businesses)
    .where(eq(businesses.id, businessId));
  const [cust] = await tx
    .select({ email: customers.email, firstName: customers.firstName })
    .from(customers)
    .where(eq(customers.id, customerId));
  if (!biz || !cust?.email) return null;
  return { businessName: biz.name, firstName: cust.firstName ?? "there", email: cust.email };
}

type DraftParams = {
  businessId: string;
  orderId: string;
  customerId: string | null;
  key: TemplateKey;
  status: "draft" | "queued";
  vars: Omit<TemplateVars, "first_name" | "business_name" | "order_number">;
  proofId?: string;
  ctx: NonNullable<EmailContext>;
  orderNumber: string; // human-facing order number for the {{order_number}} var
  /** Unique per customer-facing moment; a repeat insert is dropped and returns null. */
  dedupeKey?: string;
};

/**
 * Render a template and insert the message row. Returns the new message id, or
 * null when `dedupeKey` already exists (the customer already has, or is already
 * due, this mail).
 */
async function insertRendered(tx: Tx, p: DraftParams): Promise<string | null> {
  const template = await resolveTemplate(tx, p.businessId, p.key);
  const rendered = renderTemplate(template, {
    first_name: p.ctx.firstName,
    order_number: p.orderNumber,
    business_name: p.ctx.businessName,
    ...p.vars,
  });
  const [row] = await tx
    .insert(messages)
    .values({
      businessId: p.businessId,
      orderId: p.orderId,
      customerId: p.customerId,
      direction: "outbound",
      channel: "email",
      status: p.status,
      templateKey: p.key,
      proofId: p.proofId ?? null,
      subject: rendered.subject,
      address: p.ctx.email,
      body: rendered.body,
      dedupeKey: p.dedupeKey ?? null,
    })
    .onConflictDoNothing({ target: messages.dedupeKey, where: sql`${messages.dedupeKey} is not null` })
    .returning({ id: messages.id });
  return row?.id ?? null;
}

/**
 * Legacy/secondary path called when an order enters `awaiting_approval` outside
 * the QC email preview flow. Creates the proof row + token, then a legacy
 * `proof_ready` draft in the VA outbox. The QC screen normally creates and sends
 * the proof email before it transitions the order.
 */
export async function prepareProofForApproval(
  tx: Tx,
  order: { id: string; businessId: string; customerId: string | null; platformOrderId: string; platformOrderName: string | null },
): Promise<void> {
  // Reuse any still-pending proof for this order.
  const [pending] = await tx
    .select({ id: proofs.id })
    .from(proofs)
    .where(and(eq(proofs.orderId, order.id), isNull(proofs.decision)))
    .limit(1);
  if (pending) return;

  const token = generateProofToken();
  const [proof] = await tx
    .insert(proofs)
    .values({ businessId: order.businessId, orderId: order.id, token })
    .returning({ id: proofs.id });

  const ctx = await readEmailContext(tx, order.businessId, order.customerId);
  if (!ctx) return; // no customer email — VA will handle manually; proof still exists

  await insertRendered(tx, {
    businessId: order.businessId,
    orderId: order.id,
    customerId: order.customerId,
    key: "proof_ready",
    status: "draft",
    proofId: proof.id,
    orderNumber: order.platformOrderName ?? order.platformOrderId,
    ctx,
    vars: { proof_link: proofUrl(token) },
  });
}

/**
 * Queue the photo-request email (auto-send exception). Composed into the import
 * tx. Returns the message id so the importer can flush it best-effort, or null
 * when there is no customer email to send to.
 */
export async function queuePhotoRequest(
  tx: Tx,
  order: {
    id: string;
    businessId: string;
    customerId: string | null;
    platformOrderId: string;
    platformOrderName?: string | null;
    uploadToken: string;
  },
): Promise<string | null> {
  const ctx = await readEmailContext(tx, order.businessId, order.customerId);
  if (!ctx) return null;
  return insertRendered(tx, {
    businessId: order.businessId,
    orderId: order.id,
    customerId: order.customerId,
    key: "photo_request",
    status: "queued",
    dedupeKey: `stage:${order.id}:photo_request`,
    orderNumber: order.platformOrderName ?? order.platformOrderId,
    ctx,
    vars: { upload_link: uploadUrl(order.uploadToken) },
  });
}

/**
 * Draft a `revision_received` acknowledgement (VA-approved, so status `draft`).
 * Composed into the revision transition tx.
 */
export async function draftRevisionReceived(
  tx: Tx,
  order: { id: string; businessId: string; customerId: string | null; platformOrderId: string; platformOrderName: string | null },
): Promise<void> {
  const ctx = await readEmailContext(tx, order.businessId, order.customerId);
  if (!ctx) return;
  await insertRendered(tx, {
    businessId: order.businessId,
    orderId: order.id,
    customerId: order.customerId,
    key: "revision_received",
    status: "draft",
    orderNumber: order.platformOrderName ?? order.platformOrderId,
    ctx,
    vars: {},
  });
}

/**
 * Queue the 48h photo-reminder email (the reminders sweep's auto-send
 * exception, same as the initial photo request — see lib/reminders). Always
 * `queued`, never a VA draft: a business that opted into the initial photo
 * request wants the nudge to go out the same way.
 */
export async function queuePhotoReminder(
  tx: Tx,
  order: {
    id: string;
    businessId: string;
    customerId: string | null;
    platformOrderId: string;
    platformOrderName?: string | null;
    uploadToken: string;
  },
): Promise<string | null> {
  const ctx = await readEmailContext(tx, order.businessId, order.customerId);
  if (!ctx) return null;
  return insertRendered(tx, {
    businessId: order.businessId,
    orderId: order.id,
    customerId: order.customerId,
    key: "photo_reminder",
    status: "queued",
    orderNumber: order.platformOrderName ?? order.platformOrderId,
    ctx,
    vars: { upload_link: uploadUrl(order.uploadToken) },
  });
}

/**
 * Draft the "more photos needed" email the agent autopilot writes when an order
 * has fewer reference photos than figures ordered (lib/agent/autopilot.ts).
 * Always `draft`: a VA approves it in the outbox, because a single photo can
 * show several subjects. Returns the message id, or null with no customer email.
 */
export async function queuePhotoShortfall(
  tx: Tx,
  order: {
    id: string;
    businessId: string;
    customerId: string | null;
    platformOrderId: string;
    platformOrderName?: string | null;
    uploadToken: string;
  },
  counts: { have: number; need: number },
): Promise<string | null> {
  const ctx = await readEmailContext(tx, order.businessId, order.customerId);
  if (!ctx) return null;
  return insertRendered(tx, {
    businessId: order.businessId,
    orderId: order.id,
    customerId: order.customerId,
    key: "photo_shortfall",
    status: "draft",
    orderNumber: order.platformOrderName ?? order.platformOrderId,
    ctx,
    vars: {
      upload_link: uploadUrl(order.uploadToken),
      photos_have: String(counts.have),
      photos_need: String(counts.need),
    },
  });
}

export type StageEmailKey = "order_received" | "in_design" | "printing" | "shipped" | "proof_reminder";

/**
 * Stage emails (the customer window): order received, in the artist's hands,
 * printing, shipped. Drafted into the VA outbox on the relevant transition —
 * same insertRendered path as every other customer email — unless the
 * business has opted into `stage_email_auto_send`, in which case they queue
 * for the automatic flush like the photo-request exception. A no-op when the
 * order has no customer email (nothing to send to, nothing to draft).
 */
export async function queueStageEmail(
  tx: Tx,
  order: { id: string; businessId: string; customerId: string | null; platformOrderId: string; platformOrderName: string | null },
  key: StageEmailKey,
  vars: Omit<TemplateVars, "first_name" | "business_name" | "order_number"> = {},
): Promise<string | null> {
  const ctx = await readEmailContext(tx, order.businessId, order.customerId);
  if (!ctx) return null;
  const [biz] = await tx
    .select({ autoSend: businesses.stageEmailAutoSend, agentConfig: businesses.agentConfig })
    .from(businesses)
    .where(eq(businesses.id, order.businessId));
  // Settings > Agent can flip single templates to automatic; the default is a draft.
  const autoSend = !!biz?.autoSend || getAgentConfig(biz).autoSendTemplates.includes(key);
  // One mail per stage entry the customer should hear about. Internal re-entries
  // (reassign, AI job re-list, a status reset) hit the same key and are dropped;
  // a new proof (reminder) or a new tracking number (shipped) is a new moment.
  const moment = key === "proof_reminder" ? vars.proof_link : key === "shipped" ? vars.tracking_number : undefined;
  return insertRendered(tx, {
    dedupeKey: `stage:${order.id}:${key}${moment ? `:${moment}` : ""}`,
    businessId: order.businessId,
    orderId: order.id,
    customerId: order.customerId,
    key,
    status: autoSend ? "queued" : "draft",
    orderNumber: order.platformOrderName ?? order.platformOrderId,
    ctx,
    vars,
  });
}

/**
 * Draft a free-text reply to an inbound customer message (the agent's answer to
 * a buyer question). Always a `draft`: it waits in the VA outbox like any other
 * staff-composed email, never auto-sends. Threads onto the inbound message's
 * Gmail thread. Returns the new message id, or null when there is no address.
 */
export async function draftFreeformReply(
  tx: Tx,
  input: {
    order: { id: string; businessId: string; customerId: string | null };
    inReplyTo: { id: string; address: string | null; gmailThreadId: string | null };
    subject: string;
    body: string;
    metadata?: Record<string, unknown>;
  },
): Promise<string | null> {
  const { order, inReplyTo } = input;
  const ctx = await readEmailContext(tx, order.businessId, order.customerId);
  const address = ctx?.email ?? inReplyTo.address?.trim() ?? null;
  if (!address) return null;
  const [row] = await tx
    .insert(messages)
    .values({
      businessId: order.businessId,
      orderId: order.id,
      customerId: order.customerId,
      direction: "outbound",
      channel: "email",
      status: "draft",
      subject: input.subject,
      address,
      body: input.body,
      gmailThreadId: inReplyTo.gmailThreadId,
      metadata: { ...(input.metadata ?? {}), replyToMessageId: inReplyTo.id },
    })
    .returning({ id: messages.id });
  return row!.id;
}

export type SendResult = { ok: true } | { ok: false; error: string; retryable: boolean };

/**
 * Send one message via the business's Gmail mailbox and stamp the result on the
 * row. Opens its own system transaction. Safe to call on a `draft`, `queued`, or
 * previously `failed` row; a no-op (already `sent`) returns ok. A missing Gmail
 * connection is retryable (row left as-is); a hard send error marks the row
 * `failed`.
 */
export async function sendMessage(
  messageId: string,
  opts?: { approvedById?: string; markRetryableFailed?: boolean },
): Promise<SendResult> {
  const msg = await withSystemContext(async (tx) => {
    const [m] = await tx
      .select({
        id: messages.id,
        businessId: messages.businessId,
        status: messages.status,
        orderId: messages.orderId,
        subject: messages.subject,
        body: messages.body,
        address: messages.address,
        gmailThreadId: messages.gmailThreadId,
        direction: messages.direction,
        attachmentAssetId: messages.attachmentAssetId,
        attachmentFilename: messages.attachmentFilename,
        attachmentContentType: messages.attachmentContentType,
        manualSentAt: messages.manualSentAt,
      })
      .from(messages)
      .where(eq(messages.id, messageId));
    return m;
  });
  if (!msg) return { ok: false, error: "Message not found", retryable: false };
  // Never resend what already reached the customer (sent, or marked sent by hand).
  if (msg.status === "sent" || msg.manualSentAt) return { ok: true };
  if (msg.direction !== "outbound") return { ok: false, error: "Not an outbound message", retryable: false };
  if (!msg.address) {
    await markFailed(messageId, "No recipient address");
    return { ok: false, error: "No recipient address", retryable: false };
  }

  // Safety rail: no real customer send unless this business has sending enabled.
  // Retryable (left as-is), so turning it on later flushes the same rows.
  const sendingEnabled = await withSystemContext(async (tx) => {
    const [b] = await tx
      .select({ on: businesses.emailSendingEnabled })
      .from(businesses)
      .where(eq(businesses.id, msg.businessId));
    return !!b?.on;
  });
  if (!sendingEnabled) {
    if (opts?.markRetryableFailed) await markFailed(messageId, "Email sending is turned OFF for this business");
    return { ok: false, error: "Email sending is turned OFF for this business", retryable: true };
  }

  // Claim the row: only one pass at a time may hold a send in flight. A claim
  // older than 5 minutes is a crashed pass and may be taken over.
  const claimed = await withSystemContext((tx) =>
    tx
      .update(messages)
      .set({ sendClaimedAt: new Date() })
      .where(
        and(
          eq(messages.id, messageId),
          ne(messages.status, "sent"),
          isNull(messages.manualSentAt),
          sql`(${messages.sendClaimedAt} is null or ${messages.sendClaimedAt} < now() - interval '5 minutes')`,
        ),
      )
      .returning({ id: messages.id }),
  );
  if (!claimed.length) return { ok: false, error: "Another send of this email is in progress", retryable: true };
  const release = () =>
    withSystemContext((tx) => tx.update(messages).set({ sendClaimedAt: null }).where(eq(messages.id, messageId)));

  let client: GmailClient;
  try {
    client = await GmailClient.forBusiness(msg.businessId);
  } catch (e) {
    if (e instanceof GmailNotConnectedError) {
      if (opts?.markRetryableFailed) await markFailed(messageId, "Gmail not connected for this business");
      await release();
      return { ok: false, error: "Gmail not connected for this business", retryable: true };
    }
    throw e;
  }

  const prior = await withSystemContext(async (tx) => {
    if (msg.gmailThreadId) {
      const [byThread] = await tx
        .select({
          threadId: messages.gmailThreadId,
          rfcMessageId: messages.gmailRfcMessageId,
        })
        .from(messages)
        .where(
          and(
            eq(messages.businessId, msg.businessId),
            eq(messages.gmailThreadId, msg.gmailThreadId),
            isNotNull(messages.gmailRfcMessageId),
            ne(messages.id, messageId),
          ),
        )
        .orderBy(desc(messages.createdAt))
        .limit(1);
      if (byThread) return byThread;
    }

    if (msg.orderId) {
      const [byOrder] = await tx
        .select({
          threadId: messages.gmailThreadId,
          rfcMessageId: messages.gmailRfcMessageId,
        })
        .from(messages)
        .where(
          and(
            eq(messages.businessId, msg.businessId),
            eq(messages.orderId, msg.orderId),
            isNotNull(messages.gmailThreadId),
            isNotNull(messages.gmailRfcMessageId),
            ne(messages.id, messageId),
          ),
        )
        .orderBy(desc(messages.createdAt))
        .limit(1);
      if (byOrder) return byOrder;
    }

    return null;
  });

  try {
    const threadId = msg.gmailThreadId ?? prior?.threadId ?? undefined;
    const attachment = msg.attachmentAssetId
      ? await withSystemContext((tx) =>
          loadAssetAttachment(tx, msg.attachmentAssetId!, msg.attachmentFilename, msg.attachmentContentType),
        )
      : null;
    if (msg.attachmentAssetId && !attachment) {
      await markFailed(messageId, "Attachment asset is missing or unreadable");
      return { ok: false, error: "Attachment asset is missing or unreadable", retryable: false };
    }
    const res = await client.send(
      {
        to: msg.address,
        subject: msg.subject ?? "",
        text: msg.body ?? "",
        inReplyToMessageId: prior?.rfcMessageId ?? undefined,
        ...(attachment ? { attachments: [attachment] } : {}),
      },
      threadId ? { threadId } : undefined,
    );
    let rfcMessageId: string | null = null;
    try {
      rfcMessageId = header(await client.getMessage(res.id), "Message-ID");
    } catch (e) {
      console.log(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: "warn",
          integration: "gmail",
          businessId: msg.businessId,
          event: "sent_message_header_lookup_failed",
          gmailMessageId: res.id,
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    }
    await withSystemContext((tx) =>
      tx
        .update(messages)
        .set({
          status: "sent",
          sentAt: new Date(),
          gmailThreadId: res.threadId,
          gmailMessageId: res.id,
          gmailRfcMessageId: rfcMessageId,
          error: null,
          sendClaimedAt: null,
          ...(opts?.approvedById ? { approvedBy: opts.approvedById } : {}),
        })
        .where(eq(messages.id, messageId)),
    );
    return { ok: true };
  } catch (e) {
    // A reauth requirement is transient from the message's point of view.
    if (e instanceof GmailReauthRequiredError) {
      if (opts?.markRetryableFailed) await markFailed(messageId, "Gmail needs re-authentication");
      await release();
      return { ok: false, error: "Gmail needs re-authentication", retryable: true };
    }
    const error = e instanceof Error ? e.message : String(e);
    await markFailed(messageId, error);
    return { ok: false, error, retryable: false };
  }
}

async function markFailed(messageId: string, error: string): Promise<void> {
  await withSystemContext((tx) =>
    tx.update(messages).set({ status: "failed", error, sendClaimedAt: null }).where(eq(messages.id, messageId)),
  );
}

export async function notifyVaEmailFailure(
  tx: Tx,
  args: { businessId: string; orderId: string | null; messageId: string; error: string },
): Promise<void> {
  const staff = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.active, true), eq(users.role, "va")));
  if (!staff.length) return;
  await tx.insert(notifications).values(
    staff.map((staffer) => ({
      businessId: args.businessId,
      userId: staffer.id,
      orderId: args.orderId,
      type: "email.send_failed",
      title: "Customer email failed",
      body: args.error,
      href: args.orderId ? `/orders/${args.orderId}` : "/emails",
      metadata: { messageId: args.messageId },
    })),
  );
}

/**
 * Flush queued auto-send emails (photo requests, reminders). Best-effort: each
 * send is independent, and a not-connected business simply leaves its rows
 * queued for the next flush. Optionally scope to one business.
 */
export async function flushQueued(businessId?: string): Promise<{ sent: number; failed: number; skipped: number }> {
  const rows = await withSystemContext((tx) =>
    tx
      .select({ id: messages.id })
      .from(messages)
      .where(
        businessId
          ? and(eq(messages.status, "queued"), eq(messages.businessId, businessId))
          : eq(messages.status, "queued"),
      )
      .limit(200),
  );
  let sent = 0;
  let failed = 0;
  let skipped = 0;
  for (const r of rows) {
    const res = await sendMessage(r.id);
    if (res.ok) sent++;
    else if (res.retryable) skipped++;
    else failed++;
  }
  return { sent, failed, skipped };
}

// Re-export defaults so callers (e.g. seeding) can reference them.
export { DEFAULT_TEMPLATES };
