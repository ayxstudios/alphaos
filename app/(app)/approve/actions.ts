"use server";

import { auth } from "@/lib/auth";
import type { RequestUser } from "@/lib/db";
import { ownerApproveCore, type ApproveActionResult } from "@/lib/qc/owner-approve";
import { ownerRejectCore, type OwnerRejectInput } from "@/lib/qc/owner-reject";

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

/** Reject = a failed QC with the owner's touchups as the note (lib/qc/owner-reject.ts; the screen uses POST /api/approve/reject). */
export async function ownerReject(input: OwnerRejectInput): Promise<ApproveActionResult> {
  const staff = await requireStaff();
  if ("error" in staff) return staff.error;
  return ownerRejectCore(staff.user, staff.name, input);
}
