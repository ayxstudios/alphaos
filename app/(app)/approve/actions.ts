"use server";

import { revalidatePath } from "next/cache";

import { auth } from "@/lib/auth";
import { withUserContext, type RequestUser } from "@/lib/db";
import { MAX_QC_ATTACHMENTS } from "@/lib/qc/attachments";
import { fixPictureAssets } from "@/lib/qc/auto-qc-fix";
import { ownerApproveCore, type ApproveActionResult } from "@/lib/qc/owner-approve";
import type { ChecklistItem } from "@/lib/qc/checklist";
import { getQcContext } from "@/lib/qc/data";
import { submitQcFail } from "../qc/actions";
import { writeDecision, writeUndo, type CaseDecision, type CaseWrite } from "@/lib/cases/cards";

export type { ApproveActionResult };

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
export async function ownerApprove(orderId: string, fixIds?: string[], overrideReason?: string): Promise<ApproveActionResult> {
  const staff = await requireStaff();
  if ("error" in staff) return staff.error;
  return ownerApproveCore(staff.user, staff.name, orderId, { fixIds: Array.isArray(fixIds) ? fixIds.filter((f) => typeof f === "string") : [], overrideReason: typeof overrideReason === "string" ? overrideReason : undefined });
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
  /** AI fix samples to show the designer as pictures (2026-10-14). */
  attachFixIds?: string[];
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

  let attachmentAssetIds = input.attachmentAssetIds ?? [];
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

/**
 * A swipe on a customer case (the Cases stream, 2026-10-21). Owners only (admin): the agent does what the card says, and a
 * case can be money or a customer's reply. The decision is recorded on the case's card; the agent queues it, waits its
 * 30 s undo window and carries it out, so a wrong swipe can still be undone (undoCase).
 */
export async function decideCase(input: CaseDecision): Promise<CaseWrite> {
  const session = await auth();
  if (!session?.user) return { ok: false, message: "Please sign in again." };
  if (session.user.role !== "admin") return { ok: false, message: "Only the owners can decide cases." };
  if (typeof input?.id !== "string" || !input.id) return { ok: false, message: "That case could not be found." };
  if (input.decision === "own" && !String(input.ownerText ?? "").trim()) return { ok: false, message: "Write what to do first." };
  return writeDecision(input);
}

export async function undoCase(id: string): Promise<CaseWrite> {
  const session = await auth();
  if (!session?.user || session.user.role !== "admin") return { ok: false, message: "Only the owners can decide cases." };
  if (typeof id !== "string" || !id) return { ok: false, message: "That case could not be found." };
  return writeUndo(id);
}
