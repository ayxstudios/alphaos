"use server";

import { revalidatePath } from "next/cache";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { withUserContext, type RequestUser } from "@/lib/db";
import {
  activityLog,
  assets,
  businesses,
  customers,
  messages,
  orderItems,
  orders,
  proofs,
} from "@/lib/db/schema";
import { describeAssetAttachment } from "@/lib/email/attachments";
import { notifyVaEmailFailure, sendMessage } from "@/lib/email/dispatch";
import {
  renderTemplate,
  resolveTemplate,
  TEMPLATE_META,
  type TemplateKey,
} from "@/lib/email/templates";
import { textToHtml } from "@/lib/integrations/gmail/mime";
import {
  transition,
  OrderTransitionError,
  type OrderStatus,
} from "@/lib/orders/transitions";
import type { ChecklistSnapshot, ItemResults } from "@/lib/qc/checklist";
import { generateProofToken } from "@/lib/proofs/tokens";
import { proofUrl } from "@/lib/urls";
import { isR2Configured, presignGet } from "@/lib/storage/r2";

export type QcResult =
  | { ok: true; status: OrderStatus }
  | { ok: false; code: string; message: string };

export type QcEmailPreviewResult =
  | {
      ok: true;
      preview: {
        orderId: string;
        orderNumber: string;
        to: string;
        subject: string;
        body: string;
        html: string;
        templateKey: TemplateKey;
        templateLabel: string;
        templateReason: string;
        proofId: string;
        proofLink: string;
        attachment: {
          assetId: string;
          url: string | null;
          filename: string;
          contentType: string;
          sizeBytes: number | null;
          fingerprint: string | null;
        };
      };
    }
  | { ok: false; code: string; message: string };

/** VA/admin gate. Designers can never reach the QC screen (middleware + here). */
async function requireVa(): Promise<RequestUser | { error: Extract<QcResult, { ok: false }> }> {
  const session = await auth();
  const role = session?.user?.role;
  if (!session?.user) {
    return { error: { ok: false, code: "auth", message: "Not signed in" } };
  }
  if (role !== "admin" && role !== "va") {
    return { error: { ok: false, code: "forbidden", message: "QC is VA/admin only" } };
  }
  return { id: session.user.id, role };
}

function revalidate(orderId: string) {
  revalidatePath("/orders");
  revalidatePath("/board");
  revalidatePath(`/qc/${orderId}`);
  revalidatePath(`/orders/${orderId}`);
  revalidatePath("/dashboard");
}

/**
 * Legacy direct pass path is intentionally disabled. Passing QC now requires the
 * proof email preview/send flow so the VA verifies the exact attachment before
 * the order moves to awaiting approval.
 */
export async function submitQcPass(input: {
  orderId: string;
  expectedFrom: OrderStatus;
  checklist: ChecklistSnapshot;
  itemResults: ItemResults;
}): Promise<QcResult> {
  const auth = await requireVa();
  if ("error" in auth) return auth.error;
  void input;
  return {
    ok: false,
    code: "email_preview_required",
    message: "Pass QC from the email preview so the attachment is verified before sending.",
  };
}

export async function prepareQcEmailPreview(input: {
  orderId: string;
  expectedFrom: OrderStatus;
  checklist: ChecklistSnapshot;
  itemResults: ItemResults;
}): Promise<QcEmailPreviewResult> {
  const user = await requireVa();
  if ("error" in user) return { ok: false, code: user.error.code, message: user.error.message };
  const ticked = assertAllTicked(input.checklist, input.itemResults);
  if (!ticked.ok) return { ok: false, code: ticked.code, message: ticked.message };

  const preview = await withUserContext(user, async (tx) => {
    const ctx = await readQcEmailContext(tx, input.orderId);
    if (!ctx.ok) return ctx;
    if (ctx.order.status !== input.expectedFrom || ctx.order.status !== "awaiting_qc") {
      return { ok: false as const, code: "stale", message: "This order is no longer awaiting QC." };
    }
    const proof = await ensureProof(tx, ctx.order);
    const selection = selectProofTemplate(ctx);
    const template = await resolveTemplate(tx, ctx.order.businessId, selection.key);
    const rendered = renderTemplate(template, {
      first_name: ctx.customer.firstName ?? "there",
      order_number: ctx.order.orderNumber,
      business_name: ctx.business.name,
      proof_link: proofUrl(proof.token),
    });
    const attachment = await describeAssetAttachment(tx, ctx.asset.id, ctx.order.orderNumber);
    if (!attachment) {
      return { ok: false as const, code: "attachment", message: "The portrait asset could not be read." };
    }
    return {
      ok: true as const,
      preview: {
        orderId: input.orderId,
        orderNumber: ctx.order.orderNumber,
        to: ctx.customer.email,
        subject: rendered.subject,
        body: rendered.body,
        html: textToHtml(rendered.body),
        templateKey: selection.key,
        templateLabel: TEMPLATE_META[selection.key].label,
        templateReason: selection.reason,
        proofId: proof.id,
        proofLink: proofUrl(proof.token),
        attachment: {
          ...attachment,
          url: await resolvePreviewUrl(ctx.asset),
        },
      },
    };
  });

  return preview;
}

export async function confirmQcPassAndSend(input: {
  orderId: string;
  expectedFrom: OrderStatus;
  checklist: ChecklistSnapshot;
  itemResults: ItemResults;
  proofId: string;
  templateKey: TemplateKey;
  templateReason: string;
  attachmentAssetId: string;
  attachmentFingerprint: string | null;
  subject: string;
  body: string;
}): Promise<QcResult> {
  const user = await requireVa();
  if ("error" in user) return user.error;
  const ticked = assertAllTicked(input.checklist, input.itemResults);
  if (!ticked.ok) return ticked;

  const prepared = await withUserContext(user, async (tx) => {
    const ctx = await readQcEmailContext(tx, input.orderId);
    if (!ctx.ok) return ctx;
    if (ctx.order.status !== input.expectedFrom || ctx.order.status !== "awaiting_qc") {
      return { ok: false as const, code: "stale", message: "This order is no longer awaiting QC." };
    }
    if (ctx.asset.id !== input.attachmentAssetId) {
      return {
        ok: false as const,
        code: "stale_asset",
        message: "A newer portrait was uploaded after the preview opened. Refresh QC and review the latest file.",
      };
    }
    const proof = await ensureProof(tx, ctx.order);
    if (proof.id !== input.proofId) {
      return { ok: false as const, code: "stale_proof", message: "The proof link changed. Refresh and preview again." };
    }
    const attachment = await describeAssetAttachment(tx, ctx.asset.id, ctx.order.orderNumber);
    if (!attachment) return { ok: false as const, code: "attachment", message: "The portrait asset could not be read." };
    if (attachment.fingerprint && input.attachmentFingerprint && attachment.fingerprint !== input.attachmentFingerprint) {
      return {
        ok: false as const,
        code: "stale_asset",
        message: "The portrait file changed after the preview opened. Refresh QC and review the current file.",
      };
    }

    const [message] = await tx
      .insert(messages)
      .values({
        businessId: ctx.order.businessId,
        orderId: ctx.order.id,
        customerId: ctx.order.customerId,
        direction: "outbound",
        channel: "email",
        status: "draft",
        templateKey: input.templateKey,
        proofId: proof.id,
        subject: input.subject.trim(),
        body: input.body.trim(),
        address: ctx.customer.email,
        attachmentAssetId: attachment.assetId,
        attachmentFilename: attachment.filename,
        attachmentContentType: attachment.contentType,
        attachmentSizeBytes: attachment.sizeBytes,
        metadata: {
          qcPass: {
            expectedFrom: input.expectedFrom,
            itemResults: input.itemResults,
            checklistItems: input.checklist.items.map((item) => ({ key: item.key, label: item.label })),
            attachmentAssetId: attachment.assetId,
            attachmentFingerprint: attachment.fingerprint,
            templateReason: input.templateReason,
          },
        },
      })
      .returning({ id: messages.id });
    return {
      ok: true as const,
      messageId: message.id,
      businessId: ctx.order.businessId,
      orderId: ctx.order.id,
      proofId: proof.id,
      to: ctx.customer.email,
    };
  });

  if (!prepared.ok) return prepared;

  const sent = await sendMessage(prepared.messageId, {
    approvedById: user.id,
    markRetryableFailed: true,
  });
  if (!sent.ok) {
    await withUserContext(user, async (tx) => {
      await notifyVaEmailFailure(tx, {
        businessId: prepared.businessId,
        orderId: prepared.orderId,
        messageId: prepared.messageId,
        error: sent.error,
      });
      await tx.insert(activityLog).values({
        businessId: prepared.businessId,
        orderId: prepared.orderId,
        actorId: user.id,
        action: "email.send_failed",
        metadata: { messageId: prepared.messageId, error: sent.error, to: prepared.to },
      });
    });
    revalidate(input.orderId);
    return { ok: false, code: "email_failed", message: sent.error };
  }

  try {
    const { status } = await transition(user, {
      orderId: input.orderId,
      to: "awaiting_approval",
      expectedFrom: input.expectedFrom,
      metadata: { itemResults: input.itemResults, via: "qc_email_send", messageId: prepared.messageId },
    });
    await withUserContext(user, async (tx) => {
      await tx.update(proofs).set({ sentAt: new Date() }).where(eq(proofs.id, prepared.proofId));
      await tx.insert(activityLog).values({
        businessId: prepared.businessId,
        orderId: prepared.orderId,
        actorId: user.id,
        action: "email.sent",
        metadata: { messageId: prepared.messageId, templateKey: input.templateKey, to: prepared.to, via: "qc_pass" },
      });
    });
    revalidate(input.orderId);
    return { ok: true, status };
  } catch (err) {
    const message = err instanceof OrderTransitionError ? err.message : String(err);
    await withUserContext(user, async (tx) => {
      await notifyVaEmailFailure(tx, {
        businessId: prepared.businessId,
        orderId: prepared.orderId,
        messageId: prepared.messageId,
        error: `Email sent, but order transition failed: ${message}`,
      });
    });
    return { ok: false, code: "transition_failed_after_send", message: `Email sent, but order transition failed: ${message}` };
  }
}

/**
 * Fail QC: requires at least one failed item and a mandatory reason. Moves
 * awaiting_qc -> in_design (a revision), incrementing revisionCount. The failed
 * items + reason are persisted on qc_checks and in the activity log so they
 * reach the designer's card.
 */
export async function submitQcFail(input: {
  orderId: string;
  expectedFrom: OrderStatus;
  checklist: ChecklistSnapshot;
  failedKeys: number[];
  reason: string;
}): Promise<QcResult> {
  const auth = await requireVa();
  if ("error" in auth) return auth.error;

  const failedKeys = [...new Set(input.failedKeys)];
  const validKeys = new Set(input.checklist.items.map((it) => it.key));
  const failed = failedKeys.filter((k) => validKeys.has(k));
  const reason = input.reason.trim();

  if (failed.length === 0) {
    return { ok: false, code: "precondition", message: "Select at least one failed item" };
  }
  if (!reason) {
    return { ok: false, code: "precondition", message: "A reason is required to fail QC" };
  }

  const failedSet = new Set(failed);
  const itemResults: ItemResults = {};
  for (const it of input.checklist.items) itemResults[it.key] = !failedSet.has(it.key);

  try {
    // The transition re-resolves the checklist and re-enforces "≥1 failed + reason";
    // it derives the authoritative failed-item labels from the snapshot itself.
    const { status } = await transition(auth, {
      orderId: input.orderId,
      to: "in_design",
      expectedFrom: input.expectedFrom,
      metadata: { reason, itemResults },
    });
    revalidate(input.orderId);
    return { ok: true, status };
  } catch (err) {
    if (err instanceof OrderTransitionError) return { ok: false, code: err.code, message: err.message };
    throw err;
  }
}

function assertAllTicked(
  checklist: ChecklistSnapshot,
  itemResults: ItemResults,
): QcResult {
  const allTicked = checklist.items.every((it) => itemResults[it.key] === true);
  if (!allTicked) {
    return { ok: false, code: "precondition", message: "All checklist items must be ticked to pass" };
  }
  return { ok: true, status: "awaiting_qc" };
}

type Tx = Parameters<Parameters<typeof withUserContext>[1]>[0];

async function readQcEmailContext(tx: Tx, orderId: string) {
  const [order] = await tx
    .select({
      id: orders.id,
      businessId: orders.businessId,
      customerId: orders.customerId,
      status: orders.status,
      revisionCount: orders.revisionCount,
      platformOrderId: orders.platformOrderId,
      platformOrderName: orders.platformOrderName,
    })
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1);
  if (!order) return { ok: false as const, code: "not_found", message: "Order not found." };

  const [business] = await tx
    .select({ name: businesses.name })
    .from(businesses)
    .where(eq(businesses.id, order.businessId))
    .limit(1);
  const [customer] = order.customerId
    ? await tx
        .select({ email: customers.email, firstName: customers.firstName })
        .from(customers)
        .where(eq(customers.id, order.customerId))
        .limit(1)
    : [];
  if (!business) return { ok: false as const, code: "business", message: "Business not found." };
  if (!customer?.email) return { ok: false as const, code: "email", message: "This customer has no email address." };

  const itemRows = await tx
    .select({ productType: orderItems.productType, figureCount: orderItems.figureCount })
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId));
  if (!itemRows.length) return { ok: false as const, code: "items", message: "This order has no items." };
  if (itemRows.some((item) => item.figureCount == null)) {
    return { ok: false as const, code: "figures", message: "Resolve figure count before sending a proof email." };
  }

  const [asset] = await tx
    .select({
      id: assets.id,
      url: assets.url,
      storage: assets.storage,
      r2Key: assets.r2Key,
      type: assets.type,
      createdAt: assets.createdAt,
    })
    .from(assets)
    .where(
      and(
        eq(assets.orderId, orderId),
        inArray(assets.type, ["final", "submission"]),
        isNull(assets.deletedAt),
      ),
    )
    .orderBy(desc(assets.createdAt))
    .limit(1);
  if (!asset) return { ok: false as const, code: "attachment", message: "Upload a final portrait before sending." };

  return {
    ok: true as const,
    order: {
      ...order,
      orderNumber: order.platformOrderName ?? order.platformOrderId,
    },
    business,
    customer,
    items: itemRows,
    asset,
  };
}

function selectProofTemplate(ctx: Extract<Awaited<ReturnType<typeof readQcEmailContext>>, { ok: true }>): {
  key: TemplateKey;
  reason: string;
} {
  if (ctx.order.revisionCount > 0) {
    return { key: "revision_received", reason: "Order has already had a revision round, so the generic revision-ready template is used." };
  }
  const physical = ctx.items.some((item) => item.productType === "physical");
  const figures = ctx.items.reduce((sum, item) => sum + (item.figureCount ?? 0), 0);
  if (physical && figures === 1) return { key: "proof_ready_physical_single", reason: "Physical order with one figure." };
  if (physical) return { key: "proof_ready_physical_multi", reason: `Physical order with ${figures} figures.` };
  if (figures === 1) return { key: "proof_ready_digital_single", reason: "Digital order with one figure." };
  return { key: "proof_ready_digital_multi", reason: `Digital order with ${figures} figures.` };
}

async function ensureProof(
  tx: Tx,
  order: { id: string; businessId: string },
): Promise<{ id: string; token: string }> {
  const [pending] = await tx
    .select({ id: proofs.id, token: proofs.token })
    .from(proofs)
    .where(and(eq(proofs.orderId, order.id), isNull(proofs.decision)))
    .limit(1);
  if (pending) return pending;
  const [proof] = await tx
    .insert(proofs)
    .values({ businessId: order.businessId, orderId: order.id, token: generateProofToken() })
    .returning({ id: proofs.id, token: proofs.token });
  return proof;
}

async function resolvePreviewUrl(asset: { url: string | null; storage: string; r2Key: string | null }) {
  if (asset.url) return asset.url;
  if (asset.storage === "r2" && asset.r2Key && isR2Configured()) {
    try {
      return await presignGet(asset.r2Key);
    } catch {
      return null;
    }
  }
  return null;
}
