import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";

import { confirmQcPassAndSend, prepareQcEmailPreview } from "@/app/(app)/qc/actions";
import { approveOwnerReview } from "@/lib/agent/ai-designer";
import { withUserContext, type RequestUser } from "@/lib/db";
import { sendAiFixUsed } from "@/lib/notifications/designer-events";
import { orders } from "@/lib/db/schema";
import type { ItemResults } from "@/lib/qc/checklist";
import { aiQcRefusal } from "@/lib/qc/ai-qc-gate";
import { applyAiFixes, type AppliedFix } from "@/lib/qc/auto-qc-fix";
import { getQcContext } from "@/lib/qc/data";

/** How an approved proof leaves: emailed, queued for an Etsy message (no email on file), or held for an owner. */
export type ApproveDelivery = "email" | "etsy" | "held";

export type ApproveActionResult =
  | { ok: true; title: string; description?: string; delivery?: ApproveDelivery }
  | { ok: false; code: string; message: string };

/**
 * The whole owner Approve, shared by the server action (the /approve screen)
 * and POST /api/approve/commit (the flush when the page is closed). The caller
 * has already checked the staff session.
 *
 * `fixIds` = "Send AI fix" (2026-10-14): the AI's fix samples become the
 * order's newest artwork versions first, so the proof email carries the fixed
 * portrait and every later revision works from it; the designer is told.
 */
export async function ownerApproveCore(
  user: RequestUser,
  name: string,
  orderId: string,
  opts: { fixIds?: string[]; overrideReason?: string } = {},
): Promise<ApproveActionResult> {

  const ctx = await getQcContext(user, orderId);
  if (!ctx) return { ok: false, code: "not_found", message: "This order could not be found." };
  if (ctx.status !== "awaiting_qc") return { ok: false, code: "stale", message: "This one was already checked." };
  if (ctx.versions.length === 0) {
    return { ok: false, code: "no_artwork", message: "There is no artwork on this order yet. Open the full order to look." };
  }
  // AI portraits wait for Auto QC on the file (or fix) going out, checked before any fix is applied.
  const ai = await withUserContext(user, (tx) => aiQcRefusal(tx, user, { orderId, fixIds: opts.fixIds }));
  if (ai) return { ok: false, code: ai.code, message: ai.message };
  let applied: AppliedFix[] = [];
  if (opts.fixIds?.length) {
    const fix = await withUserContext(user, (tx) => applyAiFixes(tx, user, orderId, opts.fixIds!));
    if (!fix.ok) return { ok: false, code: fix.code, message: fix.message };
    applied = fix.applied;
  }

  const itemResults: ItemResults = {};
  for (const it of ctx.checklist.items) itemResults[it.key] = true;

  const preview = await prepareQcEmailPreview({
    orderId,
    expectedFrom: "awaiting_qc",
    checklist: ctx.checklist,
    itemResults,
    signature: name,
  });
  if (!preview.ok) return { ok: false, code: preview.code, message: preview.message };
  const p = preview.preview;

  const sent = await confirmQcPassAndSend({
    orderId,
    expectedFrom: "awaiting_qc",
    checklist: ctx.checklist,
    itemResults,
    proofId: p.proofId,
    templateKey: p.templateKey,
    templateReason: p.templateReason,
    attachmentAssetId: p.attachment.assetId,
    attachmentFingerprint: p.attachment.fingerprint,
    subject: p.subject,
    body: p.body,
    signature: name,
    overrideReason: opts.overrideReason,
  });
  if (!sent.ok) return { ok: false, code: sent.code, message: sent.message };

  const [row] = await withUserContext(user, (tx) =>
    tx.select({ aiState: orders.aiState }).from(orders).where(eq(orders.id, orderId)),
  );
  if (row?.aiState === "owner_review") {
    if (user.role !== "admin") {
      return { ok: true, title: "Approved", description: "AI portrait: it goes to the customer once an owner approves it.", delivery: "held" };
    }
    const released = await approveOwnerReview(orderId, user.id);
    revalidatePath("/approve");
    if (!released.ok) {
      return { ok: false, code: released.code, message: `Approved, but the proof is still held: ${released.message}` };
    }
  }
  if (applied.length) {
    // Best effort: the proof already went; a failed WhatsApp queue row never undoes it.
    try {
      await withUserContext(user, (tx) =>
        sendAiFixUsed(tx, { orderId, fixed: applied.flatMap((a) => a.fixed.map((f) => f.what || f.label)), fixKeys: applied.map((a) => a.key) }),
      );
    } catch (err) {
      console.error("ai fix designer note failed", orderId, err);
    }
  }
  revalidatePath("/approve");
  const who = ctx.customerName && ctx.customerName !== "-" ? ctx.customerName : "the buyer";
  if (sent.delivery === "etsy") {
    return {
      ok: true,
      title: "Queued for Etsy",
      description: `${ctx.orderNumber}: no email on file, so ${applied.length ? "the AI fix" : "the proof"} goes to ${who} as an Etsy message.`,
      delivery: "etsy",
    };
  }
  // A 2+ portrait proof too big for one email goes as several (lib/email/attachments).
  const split =
    sent.emails && sent.emails > 1
      ? ` in ${sent.emails} emails (too big for one)${sent.unsent ? `; ${sent.unsent} of them did not go yet and is retried by itself` : ""}`
      : "";
  return {
    ok: true,
    title: "Sent to the customer",
    description: `${ctx.orderNumber}: ${applied.length ? "the AI fix was" : "proof"} emailed to ${who}${split}.`,
    delivery: "email",
  };
}
