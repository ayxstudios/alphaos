"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { withUserContext, type RequestUser } from "@/lib/db";
import { activityLog, orders, users } from "@/lib/db/schema";
import { getQcContext } from "@/lib/qc/data";
import { submitPrintOrder } from "@/lib/print/submit";
import { OrderTransitionError, transition } from "@/lib/orders/transitions";
import { confirmQcPassAndSend, prepareQcEmailPreview, submitQcFail } from "@/app/(app)/qc/actions";

export type DayResult = { ok: true; message: string } | { ok: false; message: string };

async function requireStaff(): Promise<RequestUser | null> {
  const session = await auth();
  const role = session?.user?.role;
  if (!session?.user || (role !== "admin" && role !== "va")) return null;
  return { id: session.user.id, role };
}

function refresh(orderId: string) {
  revalidatePath("/day");
  revalidatePath("/qc");
  revalidatePath("/orders");
  revalidatePath("/board");
  revalidatePath(`/orders/${orderId}`);
}

/** The name on the account: the QC sign-off compares against exactly this. */
async function accountName(user: RequestUser): Promise<string> {
  const [who] = await withUserContext(user, (tx) =>
    tx.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, user.id)).limit(1),
  );
  return (who?.name || "").trim() || (who?.email || "").split("@")[0];
}

/**
 * Approve a portrait or a revision redo. There is one sending path: the
 * existing QC pass (prepare the proof email, then confirm and send). Tapping
 * Approve on the Day card is the sign-off: every check is ticked and the
 * account's own name is the signature.
 */
export async function approveQcAction(orderId: string): Promise<DayResult> {
  const user = await requireStaff();
  if (!user) return { ok: false, message: "Only staff can do QC." };
  const ctx = await getQcContext(user, orderId);
  if (!ctx) return { ok: false, message: "Order not found." };
  if (!ctx.isReviewable) return { ok: false, message: "Someone already checked this one." };

  const itemResults = Object.fromEntries(ctx.checklist.items.map((it) => [it.key, true]));
  const signature = await accountName(user);
  const preview = await prepareQcEmailPreview({
    orderId,
    expectedFrom: "awaiting_qc",
    checklist: ctx.checklist,
    itemResults,
    signature,
  });
  if (!preview.ok) return { ok: false, message: preview.message };
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
    signature,
  });
  refresh(orderId);
  return sent.ok
    ? { ok: true, message: `Proof sent to the buyer (${ctx.orderNumber}).` }
    : { ok: false, message: sent.message };
}

/**
 * Bounce a portrait or revision redo back to its designer. Uses the existing
 * QC fail: the note and the ticked "what is wrong" checks land on the card.
 */
export async function bounceQcAction(orderId: string, note: string, failedKeys: number[]): Promise<DayResult> {
  const user = await requireStaff();
  if (!user) return { ok: false, message: "Only staff can do QC." };
  const reason = note.trim().slice(0, 1000);
  if (!reason) return { ok: false, message: "Write a note for the designer first." };
  const ctx = await getQcContext(user, orderId);
  if (!ctx) return { ok: false, message: "Order not found." };
  if (!ctx.isReviewable) return { ok: false, message: "Someone already checked this one." };
  const res = await submitQcFail({
    orderId,
    expectedFrom: "awaiting_qc",
    checklist: ctx.checklist,
    failedKeys,
    reason,
    signature: await accountName(user),
  });
  refresh(orderId);
  return res.ok ? { ok: true, message: `Sent back to the designer (${ctx.orderNumber}).` } : { ok: false, message: res.message };
}

/** Approve print-and-ship: the agent-prepared order goes to the provider. */
export async function approvePrintAction(orderId: string): Promise<DayResult> {
  const user = await requireStaff();
  if (!user) return { ok: false, message: "Only staff can submit print orders." };
  const res = await submitPrintOrder({ orderId, actorUserId: user.id, actorRole: user.role });
  refresh(orderId);
  if (res.ok) return { ok: true, message: res.message };
  const blockers = res.blockers?.length ? ` ${res.blockers.join(" ")}` : "";
  return { ok: false, message: `${res.message}${blockers}` };
}

/** Bounce a print card: back to the designer's board with the note. */
export async function bouncePrintAction(orderId: string, note: string): Promise<DayResult> {
  const user = await requireStaff();
  if (!user) return { ok: false, message: "Only staff can send an order back." };
  const reason = note.trim().slice(0, 1000);
  if (!reason) return { ok: false, message: "Write a note for the designer first." };
  try {
    // revisionReason is the key the designer's card reads (see proofs/decide.ts).
    await transition(user, {
      orderId,
      to: "in_design",
      expectedFrom: "approved",
      metadata: { via: "day_bounce", revisionReason: reason },
    });
    await withUserContext(user, async (tx) => {
      const [o] = await tx.select({ businessId: orders.businessId }).from(orders).where(eq(orders.id, orderId)).limit(1);
      if (!o) return;
      await tx.insert(activityLog).values({
        businessId: o.businessId,
        orderId,
        actorId: user.id,
        action: "day.print_bounced",
        metadata: { note: reason },
      });
    });
  } catch (err) {
    if (err instanceof OrderTransitionError) return { ok: false, message: err.message };
    throw err;
  }
  refresh(orderId);
  return { ok: true, message: "Sent back to the designer." };
}
