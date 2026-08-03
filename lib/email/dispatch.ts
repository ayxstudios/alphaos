import { and, eq, isNull } from "drizzle-orm";

import { withSystemContext, type Tx } from "@/lib/db";
import { businesses, customers, messages, proofs } from "@/lib/db/schema";
import { GmailClient, GmailNotConnectedError, GmailReauthRequiredError } from "@/lib/integrations/gmail";
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
};

/** Render a template and insert the message row. Returns the new message id. */
async function insertRendered(tx: Tx, p: DraftParams): Promise<string> {
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
    })
    .returning({ id: messages.id });
  return row.id;
}

/**
 * Called when an order enters `awaiting_approval` (composed into the transition
 * tx). Creates the proof row + token, then a `proof_ready` DRAFT in the VA
 * outbox. Idempotent: if an undecided proof already exists (e.g. a hold/resume
 * bounce), it is reused and no duplicate draft is created.
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
  opts?: { approvedById?: string },
): Promise<SendResult> {
  const msg = await withSystemContext(async (tx) => {
    const [m] = await tx
      .select({
        id: messages.id,
        businessId: messages.businessId,
        status: messages.status,
        subject: messages.subject,
        body: messages.body,
        address: messages.address,
        gmailThreadId: messages.gmailThreadId,
        direction: messages.direction,
      })
      .from(messages)
      .where(eq(messages.id, messageId));
    return m;
  });
  if (!msg) return { ok: false, error: "Message not found", retryable: false };
  if (msg.status === "sent") return { ok: true };
  if (msg.direction !== "outbound") return { ok: false, error: "Not an outbound message", retryable: false };
  if (!msg.address) {
    await markFailed(messageId, "No recipient address");
    return { ok: false, error: "No recipient address", retryable: false };
  }

  let client: GmailClient;
  try {
    client = await GmailClient.forBusiness(msg.businessId);
  } catch (e) {
    if (e instanceof GmailNotConnectedError) {
      return { ok: false, error: "Gmail not connected for this business", retryable: true };
    }
    throw e;
  }

  try {
    const res = await client.send(
      { to: msg.address, subject: msg.subject ?? "", text: msg.body ?? "" },
      msg.gmailThreadId ? { threadId: msg.gmailThreadId } : undefined,
    );
    await withSystemContext((tx) =>
      tx
        .update(messages)
        .set({
          status: "sent",
          sentAt: new Date(),
          gmailThreadId: res.threadId,
          gmailMessageId: res.id,
          error: null,
          ...(opts?.approvedById ? { approvedBy: opts.approvedById } : {}),
        })
        .where(eq(messages.id, messageId)),
    );
    return { ok: true };
  } catch (e) {
    // A reauth requirement is transient from the message's point of view.
    if (e instanceof GmailReauthRequiredError) {
      return { ok: false, error: "Gmail needs re-authentication", retryable: true };
    }
    const error = e instanceof Error ? e.message : String(e);
    await markFailed(messageId, error);
    return { ok: false, error, retryable: false };
  }
}

async function markFailed(messageId: string, error: string): Promise<void> {
  await withSystemContext((tx) =>
    tx.update(messages).set({ status: "failed", error }).where(eq(messages.id, messageId)),
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
