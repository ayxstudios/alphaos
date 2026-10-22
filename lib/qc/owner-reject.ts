import { revalidatePath } from "next/cache";

import { submitQcFail } from "@/app/(app)/qc/actions";
import { withUserContext, type RequestUser } from "@/lib/db";
import { MAX_QC_ATTACHMENTS } from "@/lib/qc/attachments";
import { fixPictureAssets } from "@/lib/qc/auto-qc-fix";
import type { ChecklistItem } from "@/lib/qc/checklist";
import { getQcContext } from "@/lib/qc/data";
import type { ApproveActionResult } from "@/lib/qc/owner-approve";

export type OwnerRejectInput = {
  orderId: string;
  note: string;
  failedKeys: number[];
  attachmentAssetIds?: string[];
  /** AI fix samples to show the designer as pictures (2026-10-14). */
  attachFixIds?: string[];
};

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
 *
 * Shared by the ownerReject server action and POST /api/approve/reject. The
 * Approve screen uses the route (2026-10-22): a server action that revalidates
 * answers with a fresh render of the page and empties the browser's preloaded
 * pages, so the next order loaded from scratch after every send back.
 */
export async function ownerRejectCore(user: RequestUser, name: string, input: OwnerRejectInput): Promise<ApproveActionResult> {
  const note = String(input.note ?? "").trim();
  if (!note) return { ok: false, code: "precondition", message: "Write what needs fixing first." };

  const ctx = await getQcContext(user, input.orderId);
  if (!ctx) return { ok: false, code: "not_found", message: "This order could not be found." };
  if (ctx.status !== "awaiting_qc") return { ok: false, code: "stale", message: "This one was already checked." };

  const valid = new Set(ctx.checklist.items.map((it) => it.key));
  const picked = (Array.isArray(input.failedKeys) ? input.failedKeys : []).filter((k) => valid.has(k));
  const failedKeys = picked.length ? picked : guessFailedKeys(ctx.checklist.items, note);

  let attachmentAssetIds = (input.attachmentAssetIds ?? []).filter((a) => typeof a === "string");
  const fixIds = (input.attachFixIds ?? []).filter((f) => typeof f === "string");
  if (fixIds.length && attachmentAssetIds.length < MAX_QC_ATTACHMENTS) {
    const added = await withUserContext(user, (tx) => fixPictureAssets(tx, user, input.orderId, fixIds));
    attachmentAssetIds = [...attachmentAssetIds, ...added].slice(0, MAX_QC_ATTACHMENTS);
  }

  const res = await submitQcFail({
    orderId: input.orderId,
    expectedFrom: "awaiting_qc",
    checklist: ctx.checklist,
    failedKeys,
    reason: note,
    signature: name,
    attachmentAssetIds,
  });
  if (!res.ok) return { ok: false, code: res.code, message: res.message };
  revalidatePath("/approve");
  return { ok: true, title: `Sent back to ${ctx.designerName ?? "the designer"}`, description: "It is in Failed QC on their board with your notes." };
}
