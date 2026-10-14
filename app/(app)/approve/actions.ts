"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { withUserContext, type RequestUser } from "@/lib/db";
import { orders } from "@/lib/db/schema";
import { approveOwnerReview } from "@/lib/agent/ai-designer";
import type { ChecklistItem, ItemResults } from "@/lib/qc/checklist";
import { getQcContext } from "@/lib/qc/data";
import { confirmQcPassAndSend, prepareQcEmailPreview, submitQcFail } from "../qc/actions";

export type ApproveActionResult =
  | { ok: true; title: string; description?: string }
  | { ok: false; code: string; message: string };

async function requireStaff(): Promise<{ user: RequestUser; name: string } | { error: ApproveActionResult }> {
  const session = await auth();
  if (!session?.user) return { error: { ok: false, code: "auth", message: "Please sign in again." } };
  const role = session.user.role;
  if (role !== "admin" && role !== "va") {
    return { error: { ok: false, code: "forbidden", message: "Only staff can approve artwork." } };
  }
  const name = (session.user.name || session.user.email || "Staff").trim();
  return { user: { id: session.user.id, role }, name: name.length >= 2 ? name : "Staff" };
}

/**
 * Approve = the whole VA "Pass, then send" in one tap: every check ticked,
 * signed with the approver's name, the auto-picked proof email sent to the
 * customer, the order on to awaiting approval. An AI portrait the business
 * holds for the owner (aiOwnerApproval) is released in the same tap when an
 * owner (admin) approves it: their tap IS the owner approval.
 */
export async function ownerApprove(orderId: string): Promise<ApproveActionResult> {
  const staff = await requireStaff();
  if ("error" in staff) return staff.error;
  const { user, name } = staff;

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

/** Which check a rejection most likely means, from the owner's own words. */
const HINTS: [RegExp, RegExp][] = [
  [/likeness|face|resembl/i, /face|eye|hair|nose|mouth|smile|look(s)? like|likeness|resembl|skin|beard|glasses|age|older|younger/i],
  [/count/i, /missing|extra|count|number of|add (a|the|her|his)|remove (the|a)|forgot/i],
  [/style/i, /style|cartoon|realistic|real|colou?r|background|palette|tone|bright|dark/i],
  [/detail/i, /text|name|word|spell|letter|font|tattoo|jewel|necklace|ring|earring|collar|marking|spot|patch|clothes|shirt|dress/i],
  [/finish/i, /hand|finger|ear|edge|blur|crop|cut off|clean|messy|smudge|quality|resolution|pixel/i],
];

function guessFailedKeys(items: ChecklistItem[], note: string): number[] {
  for (const [labelRe, noteRe] of HINTS) {
    if (!noteRe.test(note)) continue;
    const item = items.find((it) => labelRe.test(it.label));
    if (item) return [item.key];
  }
  const details = items.find((it) => /detail/i.test(it.label));
  return [(details ?? items[items.length - 1]).key];
}

/**
 * Reject = a failed QC with the owner's touchups as the note: back to the
 * designer (in_design, Failed QC on their board) with the words verbatim.
 * Ticking what is wrong is optional; with nothing ticked the check the words
 * point at is marked (Details when nothing matches).
 */
export async function ownerReject(input: {
  orderId: string;
  note: string;
  failedKeys: number[];
  attachmentAssetIds?: string[];
}): Promise<ApproveActionResult> {
  const staff = await requireStaff();
  if ("error" in staff) return staff.error;
  const { user, name } = staff;
  const note = input.note.trim();
  if (!note) return { ok: false, code: "precondition", message: "Write what needs fixing first." };

  const ctx = await getQcContext(user, input.orderId);
  if (!ctx) return { ok: false, code: "not_found", message: "This order could not be found." };
  if (ctx.status !== "awaiting_qc") return { ok: false, code: "stale", message: "This one was already checked." };

  const valid = new Set(ctx.checklist.items.map((it) => it.key));
  const picked = input.failedKeys.filter((k) => valid.has(k));
  const failedKeys = picked.length ? picked : guessFailedKeys(ctx.checklist.items, note);

  const res = await submitQcFail({
    orderId: input.orderId,
    expectedFrom: "awaiting_qc",
    checklist: ctx.checklist,
    failedKeys,
    reason: note,
    signature: name,
    attachmentAssetIds: input.attachmentAssetIds,
  });
  if (!res.ok) return { ok: false, code: res.code, message: res.message };
  revalidatePath("/approve");
  return { ok: true, title: `Sent back to ${ctx.designerName ?? "the designer"}`, description: "It is in Failed QC on their board with your notes." };
}
