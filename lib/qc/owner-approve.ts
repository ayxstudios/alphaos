import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";

import { confirmQcPassAndSend, prepareQcEmailPreview } from "@/app/(app)/qc/actions";
import { approveOwnerReview } from "@/lib/agent/ai-designer";
import { withUserContext, type RequestUser } from "@/lib/db";
import { orders } from "@/lib/db/schema";
import type { ItemResults } from "@/lib/qc/checklist";
import { getQcContext } from "@/lib/qc/data";

export type ApproveActionResult =
  | { ok: true; title: string; description?: string }
  | { ok: false; code: string; message: string };

/**
 * The whole owner Approve, shared by the server action (the /approve screen)
 * and POST /api/approve/commit (the flush when the page is closed). The caller
 * has already checked the staff session.
 */
export async function ownerApproveCore(user: RequestUser, name: string, orderId: string): Promise<ApproveActionResult> {

  const ctx = await getQcContext(user, orderId);
  if (!ctx) return { ok: false, code: "not_found", message: "This order could not be found." };
  if (ctx.status !== "awaiting_qc") return { ok: false, code: "stale", message: "This one was already checked." };
  if (ctx.versions.length === 0) {
    return { ok: false, code: "no_artwork", message: "There is no artwork on this order yet. Open the full order to look." };
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
  });
  if (!sent.ok) return { ok: false, code: sent.code, message: sent.message };

  const [row] = await withUserContext(user, (tx) =>
    tx.select({ aiState: orders.aiState }).from(orders).where(eq(orders.id, orderId)),
  );
  if (row?.aiState === "owner_review") {
    if (user.role !== "admin") {
      return { ok: true, title: "Approved", description: "AI portrait: it goes to the customer once an owner approves it." };
    }
    const released = await approveOwnerReview(orderId, user.id);
    revalidatePath("/approve");
    if (!released.ok) {
      return { ok: false, code: released.code, message: `Approved, but the email is still held: ${released.message}` };
    }
  }
  revalidatePath("/approve");
  return { ok: true, title: "Sent to the customer", description: `${ctx.orderNumber}: proof emailed to ${ctx.customerName}.` };
}
