"use server";

import { revalidatePath } from "next/cache";
import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";

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
  shops,
} from "@/lib/db/schema";
import { describeProofAttachments, MAX_EMAIL_ATTACHMENT_BYTES, type ProofAttachment } from "@/lib/email/attachments";
import { notifyVaEmailFailure, sendMessage } from "@/lib/email/dispatch";
import {
  renderTemplate,
  resolveTemplate,
  TEMPLATE_META,
  type TemplateKey,
} from "@/lib/email/templates";
import { textToHtml } from "@/lib/integrations/gmail/mime";
import { claimedMessage, claimHolder } from "@/lib/qc/claims";
import {
  assertQcPassAllowed,
  runTransition,
  transition,
  OrderTransitionError,
  type OrderStatus,
} from "@/lib/orders/transitions";
import type { ChecklistSnapshot, ItemResults } from "@/lib/qc/checklist";
import { getQcFailContext } from "@/lib/qc/data";
import { autoResolveOrderFigures } from "@/lib/orders/figure-auto";
import { qcPassEmailInFlight } from "@/lib/qc/send-guard";
import { aiQcRefusal } from "@/lib/qc/ai-qc-gate";
import { holdForOwnerReview, ownerReviewRequired } from "@/lib/agent/ai-designer";
import { loadProofFilePick, portraitList } from "@/lib/proofs/files";
import { generateProofToken } from "@/lib/proofs/tokens";
import { proofUrl } from "@/lib/urls";
import { isR2Configured, presignGet } from "@/lib/storage/r2";

/**
 * How the proof reaches the customer: by email, or (an Etsy buyer with no
 * email on file) as an Etsy message the shop desk sends from the shop's inbox.
 */
export type ProofDelivery = "email" | "etsy";

/** Shown where an email address would be when the proof goes by Etsy message. */
const ETSY_DELIVERY_TO = "Etsy message to the buyer (no email on file)";

export type QcResult =
  | { ok: true; status: OrderStatus; delivery?: ProofDelivery }
  | { ok: false; code: string; message: string };

export type QcEmailPreviewResult =
  | {
      ok: true;
      preview: {
        orderId: string;
        orderNumber: string;
        to: string;
        delivery: ProofDelivery;
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
        /** Every file the email carries, in portrait order (one on a one-portrait order). */
        attachments: {
          assetId: string;
          n: number;
          label: string;
          url: string | null;
          filename: string;
          contentType: string;
          sizeBytes: number | null;
        }[];
      };
    }
  | { ok: false; code: string; message: string };

/** VA/admin gate. Designers can never reach the QC screen (middleware + here). */
async function requireVa(): Promise<RequestUser | { error: Extract<QcResult, { ok: false }> }> {
  const session = await auth();
  const role = session?.user?.role;
  if (!session?.user) {
    return { error: { ok: false, code: "auth", message: "Please sign in again." } };
  }
  if (role !== "admin" && role !== "va") {
    return { error: { ok: false, code: "forbidden", message: "Only VAs and admins can do QC." } };
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
    message: "Press Pass, then send it from the email screen.",
  };
}

export async function prepareQcEmailPreview(input: {
  orderId: string;
  expectedFrom: OrderStatus;
  checklist: ChecklistSnapshot;
  itemResults: ItemResults;
  signature: string;
}): Promise<QcEmailPreviewResult> {
  const user = await requireVa();
  if ("error" in user) return { ok: false, code: user.error.code, message: user.error.message };
  const ticked = assertAllTicked(input.checklist, input.itemResults);
  if (!ticked.ok) return { ok: false, code: ticked.code, message: ticked.message };

  const preview = await withUserContext(user, async (tx) => {
    const ctx = await readQcEmailContext(tx, input.orderId);
    if (!ctx.ok) return ctx;
    if (ctx.order.status !== input.expectedFrom || ctx.order.status !== "awaiting_qc") {
      return { ok: false as const, code: "stale", message: "Someone already checked this one." };
    }
    // Two owners (lib/qc/claims.ts): the one who opened it first decides it.
    const holder = await claimHolder(tx, input.orderId, user.id);
    if (holder) return { ok: false as const, code: "claimed", message: claimedMessage(holder.holder) };
    const proof = await ensureProof(tx, ctx.order);
    const selection = selectProofTemplate(ctx);
    const template = await resolveTemplate(tx, ctx.order.businessId, selection.key);
    const rendered = renderTemplate(template, {
      first_name: ctx.customer.firstName ?? "there",
      order_number: ctx.order.orderNumber,
      business_name: ctx.business.name,
      proof_link: proofUrl(proof.token),
    });
    const set = await proofAttachments(tx, ctx);
    if (!set.ok) return set;
    const first = set.files[0];
    return {
      ok: true as const,
      preview: {
        orderId: input.orderId,
        orderNumber: ctx.order.orderNumber,
        to: ctx.delivery === "etsy" ? ETSY_DELIVERY_TO : ctx.customer.email ?? ETSY_DELIVERY_TO,
        delivery: ctx.delivery,
        subject: rendered.subject,
        body: rendered.body,
        html: textToHtml(rendered.body),
        templateKey: selection.key,
        templateLabel: TEMPLATE_META[selection.key].label,
        templateReason: selection.reason,
        proofId: proof.id,
        proofLink: proofUrl(proof.token),
        attachment: {
          assetId: first.assetId,
          filename: first.filename,
          contentType: first.contentType,
          sizeBytes: first.sizeBytes,
          fingerprint: set.fingerprint,
          url: await resolvePreviewUrl(ctx.asset),
        },
        attachments: await Promise.all(
          set.files.map(async (f, i) => ({
            assetId: f.assetId,
            n: f.n,
            label: f.label,
            filename: f.filename,
            contentType: f.contentType,
            sizeBytes: f.sizeBytes,
            url: await resolvePreviewUrl(ctx.assets[i]),
          })),
        ),
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
  signature: string;
}): Promise<QcResult> {
  const user = await requireVa();
  if ("error" in user) return user.error;
  const ticked = assertAllTicked(input.checklist, input.itemResults);
  if (!ticked.ok) return ticked;

  const prepared = await withUserContext(user, async (tx) => {
    // Row lock: a second "Pass and send" for this order waits here until the
    // first one's draft is committed, then qcPassEmailInFlight sees it.
    const [locked] = await tx
      .select({ shopId: orders.shopId })
      .from(orders)
      .where(eq(orders.id, input.orderId))
      .for("update");
    const ctx = await readQcEmailContext(tx, input.orderId);
    if (!ctx.ok) return ctx;
    if (ctx.order.status !== input.expectedFrom || ctx.order.status !== "awaiting_qc") {
      return { ok: false as const, code: "stale", message: "Someone already checked this one." };
    }
    // Under the row lock: someone else has it open on /approve, so it is theirs.
    const holder = await claimHolder(tx, input.orderId, user.id);
    if (holder) return { ok: false as const, code: "claimed", message: claimedMessage(holder.holder) };
    // The transition's own gate (sign-off, authoritative checklist) runs after
    // the send, so check it now: a refused pass must never email the customer.
    try {
      await assertQcPassAllowed(tx, user, { shopId: locked.shopId }, {
        itemResults: input.itemResults,
        signature: input.signature,
      });
    } catch (err) {
      if (err instanceof OrderTransitionError) return { ok: false as const, code: err.code, message: err.message };
      throw err;
    }
    if (ctx.asset.id !== input.attachmentAssetId) {
      return {
        ok: false as const,
        code: "stale_asset",
        message: "The designer added a newer portrait. Refresh and check that one.",
      };
    }
    // AI portraits: only an owner, and only once Auto QC has judged this exact file (lib/qc/ai-qc-gate.ts).
    const ai = await aiQcRefusal(tx, user, { orderId: ctx.order.id, assetId: ctx.asset.id });
    if (ai) return { ok: false as const, code: ai.code, message: ai.message };
    const proof = await ensureProof(tx, ctx.order);
    if (proof.id !== input.proofId) {
      return { ok: false as const, code: "stale_proof", message: "The proof link changed. Refresh and preview again." };
    }
    const set = await proofAttachments(tx, ctx);
    if (!set.ok) return set;
    const attachment = { ...set.files[0], fingerprint: set.fingerprint };
    if (attachment.fingerprint && input.attachmentFingerprint && attachment.fingerprint !== input.attachmentFingerprint) {
      return {
        ok: false as const,
        code: "stale_asset",
        message: "The portrait changed while you were looking. Refresh and check it again.",
      };
    }
    if (await qcPassEmailInFlight(tx, { orderId: ctx.order.id, proofId: proof.id })) {
      return {
        ok: false as const,
        code: "already_sent",
        message: "This email was just sent. Refresh to see where the order is now.",
      };
    }

    const [message] = await tx
      .insert(messages)
      .values({
        businessId: ctx.order.businessId,
        orderId: ctx.order.id,
        customerId: ctx.order.customerId,
        direction: "outbound",
        // No email on an Etsy order: the shop desk delivers it as an Etsy
        // message (sendMessage only queues an etsy row, see lib/email/dispatch).
        channel: ctx.delivery,
        status: "draft",
        templateKey: input.templateKey,
        proofId: proof.id,
        subject: input.subject.trim(),
        body: input.body.trim(),
        address: ctx.delivery === "email" ? ctx.customer.email : null,
        attachmentAssetId: attachment.assetId,
        attachmentFilename: attachment.filename,
        attachmentContentType: attachment.contentType,
        attachmentSizeBytes: attachment.sizeBytes,
        metadata: {
          qcPass: {
            expectedFrom: input.expectedFrom,
            itemResults: input.itemResults,
            signature: input.signature,
            checklistItems: input.checklist.items.map((item) => ({ key: item.key, label: item.label })),
            attachmentAssetId: attachment.assetId,
            attachmentFingerprint: attachment.fingerprint,
            templateReason: input.templateReason,
          },
          ...(ctx.delivery === "etsy" ? { delivery: "etsy_message", reason: "no_email" } : {}),
          // 2+ portraits: every file goes with the email (lib/email/dispatch).
          ...(set.files.length > 1
            ? {
                proofFiles: set.files.map((f) => ({
                  assetId: f.assetId,
                  n: f.n,
                  label: f.label,
                  filename: f.filename,
                  contentType: f.contentType,
                  sizeBytes: f.sizeBytes,
                })),
              }
            : {}),
        },
      })
      .returning({ id: messages.id });
    // What this proof shows, in order: the proof page lists these files, and
    // the next round's file pick keeps each portrait where the customer saw it.
    await tx
      .update(proofs)
      .set({ files: ctx.files.map((f) => ({ assetId: f.assetId, label: f.label, n: f.n, slotKey: f.slotKey })) })
      .where(eq(proofs.id, proof.id));
    // AI portraits wait for the owner (aiOwnerApproval): the pass is recorded
    // and the order moves on, but the proof email is held as a draft.
    const hold = await ownerReviewRequired(tx, ctx.order.id, ctx.order.businessId);
    return {
      ok: true as const,
      hold,
      messageId: message.id,
      businessId: ctx.order.businessId,
      orderId: ctx.order.id,
      proofId: proof.id,
      to: ctx.delivery === "email" ? ctx.customer.email : ETSY_DELIVERY_TO,
      delivery: ctx.delivery,
    };
  });

  if (!prepared.ok) return prepared;

  // An email goes out before the order moves on (a refused send keeps it in
  // QC). An Etsy delivery is only a queued row, so it is released after the
  // move, and a failed move leaves nothing for the shop desk to send.
  const sent =
    prepared.hold || prepared.delivery === "etsy"
      ? ({ ok: true } as const)
      : await sendMessage(prepared.messageId, {
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
    // The raw provider error is in the activity log and the VA alert; the
    // person gets what happened and what to do.
    return {
      ok: false,
      code: "email_failed",
      message: "The proof email did not go out, so the order stays in QC. Try Pass again in a minute. If it keeps failing, tell an admin.",
    };
  }

  try {
    // An Etsy proof is queued in the same transaction as the move: the order
    // never waits for approval with its proof stuck as an unsent draft.
    const queueEtsy = prepared.delivery === "etsy" && !prepared.hold;
    const { status } = await withUserContext(user, async (tx) => {
      const moved = await runTransition(tx, user, {
        orderId: input.orderId,
        to: "awaiting_approval",
        expectedFrom: input.expectedFrom,
        metadata: {
          itemResults: input.itemResults,
          signature: input.signature,
          via: prepared.delivery === "etsy" ? "qc_etsy_queue" : "qc_email_send",
          messageId: prepared.messageId,
        },
      });
      if (queueEtsy) {
        await tx
          .update(messages)
          .set({ status: "queued", approvedBy: user.id, error: null })
          .where(and(eq(messages.id, prepared.messageId), eq(messages.status, "draft")));
        await tx.insert(activityLog).values({
          businessId: prepared.businessId,
          orderId: prepared.orderId,
          actorId: user.id,
          action: "etsy.queued",
          metadata: { messageId: prepared.messageId, templateKey: input.templateKey, reason: "no_email", via: "qc_pass" },
        });
      }
      return moved;
    });
    if (prepared.hold) {
      await withUserContext(user, (tx) =>
        holdForOwnerReview(tx, { orderId: prepared.orderId, businessId: prepared.businessId, messageId: prepared.messageId, byUserId: user.id }),
      );
      revalidate(input.orderId);
      return { ok: true, status, delivery: prepared.delivery };
    }
    if (queueEtsy) {
      // Queued, not delivered: proofs.sent_at is stamped by the shop desk once
      // the Etsy message has really gone out (and the row is marked sent).
      revalidate(input.orderId);
      return { ok: true, status, delivery: "etsy" };
    }
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
    return { ok: true, status, delivery: "email" };
  } catch (err) {
    const message = err instanceof OrderTransitionError ? err.message : String(err);
    if (prepared.delivery === "etsy") {
      // Nothing reached the buyer either way. If the order did not move (the
      // move and the queueing roll back together), park the row as failed so
      // the shop desk never sends it and a second Approve is not blocked by
      // the send guard. If it moved but the owner hold failed, keep the draft.
      const moved = await withUserContext(user, async (tx) => {
        const [now] = await tx.select({ status: orders.status }).from(orders).where(eq(orders.id, prepared.orderId));
        if (now?.status !== input.expectedFrom) return true;
        await tx
          .update(messages)
          .set({ status: "failed", error: `The order did not move on: ${message}` })
          .where(and(eq(messages.id, prepared.messageId), inArray(messages.status, ["draft", "queued"])));
        return false;
      });
      revalidate(input.orderId);
      if (moved) {
        return { ok: false, code: "hold_failed", message: `The order moved on, but its Etsy message was not set up. Tell an admin. (${message})` };
      }
      return { ok: false, code: "transition_failed", message: `The order did not move on, so nothing went to the buyer. Try again. (${message})` };
    }
    await withUserContext(user, async (tx) => {
      await notifyVaEmailFailure(tx, {
        businessId: prepared.businessId,
        orderId: prepared.orderId,
        messageId: prepared.messageId,
        error: `The email went out, but the order did not move on. Tell an admin. (${message})`,
      });
    });
    return { ok: false, code: "transition_failed_after_send", message: `The email went out, but the order did not move on. Tell an admin. (${message})` };
  }
}

/**
 * Fail QC: requires at least one failed item and a mandatory reason. Moves
 * awaiting_qc -> in_design (a revision), incrementing revisionCount. The failed
 * items + reason are persisted on qc_checks and in the activity log so they
 * reach the designer's card.
 */
/**
 * Everything the board's drag-to-fail dialog needs before it can open:
 * the order's checklist (from its shop).
 */
export async function loadBoardFailContext(orderId: string): Promise<
  | { ok: true; checklist: ChecklistSnapshot }
  | { ok: false; code: string; message: string }
> {
  const auth = await requireVa();
  if ("error" in auth) return auth.error;
  const ctx = await getQcFailContext(auth, orderId);
  if (!ctx) return { ok: false, code: "not_found", message: "Order not found." };
  if (ctx.status !== "awaiting_qc") {
    return { ok: false, code: "stale", message: "This order is no longer awaiting QC." };
  }
  return { ok: true, checklist: ctx.checklist };
}

export async function submitQcFail(input: {
  orderId: string;
  expectedFrom: OrderStatus;
  checklist: ChecklistSnapshot;
  failedKeys: number[];
  reason: string;
  signature: string;
  /** Pictures from the fail dialog (qc_feedback assets of this order); verified in the transition. */
  attachmentAssetIds?: string[];
}): Promise<QcResult> {
  const auth = await requireVa();
  if ("error" in auth) return auth.error;

  const failedKeys = [...new Set(input.failedKeys)];
  const validKeys = new Set(input.checklist.items.map((it) => it.key));
  const failed = failedKeys.filter((k) => validKeys.has(k));
  const reason = input.reason.trim();

  if (failed.length === 0) {
    return { ok: false, code: "precondition", message: "Pick at least one thing that is wrong." };
  }
  if (!reason) {
    return { ok: false, code: "precondition", message: "Write a note for the designer first." };
  }

  // Two owners (lib/qc/claims.ts): someone else has it open, so it is their call.
  const holder = await withUserContext(auth, (tx) => claimHolder(tx, input.orderId, auth.id));
  if (holder) return { ok: false, code: "claimed", message: claimedMessage(holder.holder) };

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
      metadata: {
        reason,
        itemResults,
        signature: input.signature,
        attachmentAssetIds: input.attachmentAssetIds ?? [],
      },
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
    return { ok: false, code: "precondition", message: "Tick every line before you pass." };
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
      shopId: orders.shopId,
      // Etsy receipt ship-to name: a first-name fallback when there is no
      // customer row (skipped on gifts, where it names the recipient).
      receiptName: sql<string | null>`case when coalesce(${orders.rawImport}->>'is_gift', 'false') <> 'true' then ${orders.rawImport}->>'name' end`,
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
  // No email on file: an Etsy order still gets its proof, as an Etsy message
  // the shop desk sends (Etsy often hides the buyer's email). Anywhere else
  // there is no other way to reach them, so ask for the email.
  const email = customer?.email?.trim() || null;
  let delivery: ProofDelivery = "email";
  if (!email) {
    const [shop] = await tx.select({ platform: shops.platform }).from(shops).where(eq(shops.id, order.shopId)).limit(1);
    if (shop?.platform !== "etsy") {
      return {
        ok: false as const,
        code: "email",
        message: "No email on file for this customer. Add their email on the order, then approve again.",
      };
    }
    delivery = "etsy";
  }
  const firstName = customer?.firstName?.trim() || order.receiptName?.trim().split(/\s+/)[0] || null;

  const itemRows = await tx
    .select({ productType: orderItems.productType, figureCount: orderItems.figureCount })
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId));
  if (!itemRows.length) return { ok: false as const, code: "items", message: "This order has no items." };
  // The proof email only picks single vs multi wording from this, so a count the
  // order cannot supply never blocks the send. Fill what the order already says
  // (saved with its source); the pay guard on completion stays strict.
  if (itemRows.some((item) => item.figureCount == null)) {
    await autoResolveOrderFigures(tx, orderId);
    const again = await tx
      .select({ productType: orderItems.productType, figureCount: orderItems.figureCount })
      .from(orderItems)
      .where(eq(orderItems.orderId, orderId));
    itemRows.splice(0, itemRows.length, ...again);
  }

  // The files the email carries: the newest upload, or one per portrait on a
  // 2+ portrait order, which only goes out with every portrait (Yousif
  // 2026-10-14, 4199589633: the dog was uploaded but only the cat showed).
  const pick = await loadProofFilePick(tx, orderId);
  if (pick.mode === "slots" && pick.missing.length) {
    const gap = pick.missing.map((m) => m.n);
    return {
      ok: false as const,
      code: "portraits_missing",
      message: `${portraitList(gap)} of ${pick.expected} ${gap.length === 1 ? "has" : "have"} no file yet. Send it back to the designer.`,
    };
  }
  const fileRows = pick.files.length
    ? await tx
        .select({
          id: assets.id,
          url: assets.url,
          storage: assets.storage,
          r2Key: assets.r2Key,
          type: assets.type,
          createdAt: assets.createdAt,
        })
        .from(assets)
        .where(and(inArray(assets.id, pick.files.map((f) => f.assetId)), isNull(assets.deletedAt)))
    : [];
  const fileAssets = pick.files.map((f) => fileRows.find((r) => r.id === f.assetId));
  if (!fileAssets.length || fileAssets.some((a) => !a)) {
    return { ok: false as const, code: "attachment", message: "Upload a final portrait before sending." };
  }
  const orderedAssets = fileAssets as NonNullable<(typeof fileAssets)[number]>[];
  const asset = orderedAssets[0];

  // Has the CUSTOMER already seen a proof and asked for changes? revisionCount
  // also counts QC fails, which the customer never saw, so it cannot pick the
  // "revised portrait" wording on its own. A proof already sent, or a
  // customer-side move back to design (older orders), means this is a revision.
  const [sentProof] = await tx
    .select({ id: proofs.id })
    .from(proofs)
    .where(and(eq(proofs.orderId, orderId), isNotNull(proofs.sentAt)))
    .limit(1);
  const [customerRevision] = sentProof
    ? [sentProof]
    : await tx
        .select({ id: activityLog.id })
        .from(activityLog)
        .where(
          and(
            eq(activityLog.orderId, orderId),
            eq(activityLog.toState, "in_design"),
            inArray(activityLog.fromState, ["awaiting_approval", "approved", "printing", "shipped", "delivered", "complete"]),
          ),
        )
        .limit(1);

  return {
    ok: true as const,
    order: {
      ...order,
      orderNumber: order.platformOrderName ?? order.platformOrderId,
    },
    business,
    customer: { email, firstName },
    delivery,
    items: itemRows,
    asset,
    /** Every file the email carries, in portrait order; asset is the first. */
    files: pick.files,
    assets: orderedAssets,
    customerHasSeenProof: !!customerRevision,
  };
}

type QcEmailContext = Extract<Awaited<ReturnType<typeof readQcEmailContext>>, { ok: true }>;

/** Every file the proof email carries, or why it cannot go out. */
async function proofAttachments(
  tx: Tx,
  ctx: QcEmailContext,
): Promise<{ ok: true; files: ProofAttachment[]; fingerprint: string | null } | { ok: false; code: string; message: string }> {
  const set = await describeProofAttachments(tx, ctx.files, ctx.order.orderNumber, ctx.business.name);
  if (!set) {
    return {
      ok: false,
      code: "attachment",
      message: `${ctx.files.length > 1 ? "A portrait file" : "The portrait file"} could not be opened. Ask the designer to add it again.`,
    };
  }
  if (ctx.delivery === "email" && set.files.length > 1 && set.totalBytes != null && set.totalBytes > MAX_EMAIL_ATTACHMENT_BYTES) {
    const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);
    return {
      ok: false,
      code: "too_big",
      message: `The ${set.files.length} portraits are ${mb(set.totalBytes)} MB together, more than one email can carry (${mb(MAX_EMAIL_ATTACHMENT_BYTES)} MB). Ask the designer for smaller files (JPG), then send again.`,
    };
  }
  return { ok: true, files: set.files, fingerprint: set.fingerprint };
}

function selectProofTemplate(ctx: QcEmailContext): {
  key: TemplateKey;
  reason: string;
} {
  if (ctx.customerHasSeenProof) {
    return { key: "revision_received", reason: "The customer already saw a proof and asked for changes, so the revision-ready template is used." };
  }
  const physical = ctx.items.some((item) => item.productType === "physical");
  const figures = ctx.items.reduce((sum, item) => sum + (item.figureCount ?? 0), 0);
  if (physical && figures === 1) return { key: "proof_ready_physical_single", reason: "Physical order with one figure." };
  const unknown = ctx.items.some((item) => item.figureCount == null);
  const how = unknown ? "an unconfirmed number of" : String(figures);
  if (physical) return { key: "proof_ready_physical_multi", reason: `Physical order with ${how} figures.` };
  if (figures === 1) return { key: "proof_ready_digital_single", reason: "Digital order with one figure." };
  return { key: "proof_ready_digital_multi", reason: `Digital order with ${how} figures.` };
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
