"use server";

import { revalidatePath } from "next/cache";

import { auth } from "@/lib/auth";
import type { RequestUser } from "@/lib/db";
import {
  transition,
  OrderTransitionError,
  type OrderStatus,
} from "@/lib/orders/transitions";
import type { ChecklistSnapshot, ItemResults } from "@/lib/qc/checklist";

export type QcResult =
  | { ok: true; status: OrderStatus }
  | { ok: false; code: string; message: string };

/** VA/admin gate. Designers can never reach the QC screen (middleware + here). */
async function requireVa(): Promise<RequestUser | { error: QcResult }> {
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
  revalidatePath("/queue");
  revalidatePath("/board");
  revalidatePath(`/qc/${orderId}`);
}

/**
 * Pass QC: requires every checklist item ticked. Moves awaiting_qc ->
 * awaiting_approval through the state machine, which snapshots the checklist and
 * per-item results onto the qc_checks row. The VA's identity is stamped there.
 */
export async function submitQcPass(input: {
  orderId: string;
  expectedFrom: OrderStatus;
  checklist: ChecklistSnapshot;
  itemResults: ItemResults;
}): Promise<QcResult> {
  const auth = await requireVa();
  if ("error" in auth) return auth.error;

  const allTicked = input.checklist.items.every((it) => input.itemResults[it.key] === true);
  if (!allTicked) {
    return { ok: false, code: "precondition", message: "All checklist items must be ticked to pass" };
  }

  try {
    const { status } = await transition(auth, {
      orderId: input.orderId,
      to: "awaiting_approval",
      expectedFrom: input.expectedFrom,
      metadata: {
        checklistSnapshot: input.checklist,
        itemResults: input.itemResults,
      },
    });
    revalidate(input.orderId);
    return { ok: true, status };
  } catch (err) {
    if (err instanceof OrderTransitionError) return { ok: false, code: err.code, message: err.message };
    throw err;
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
  const failedItems = input.checklist.items
    .filter((it) => failedSet.has(it.key))
    .map((it) => it.label);

  try {
    const { status } = await transition(auth, {
      orderId: input.orderId,
      to: "in_design",
      expectedFrom: input.expectedFrom,
      metadata: {
        reason,
        failedItems,
        checklistSnapshot: input.checklist,
        itemResults,
      },
    });
    revalidate(input.orderId);
    return { ok: true, status };
  } catch (err) {
    if (err instanceof OrderTransitionError) return { ok: false, code: err.code, message: err.message };
    throw err;
  }
}
