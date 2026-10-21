/**
 * Revision stop (Yousif 2026-10-22, CPS Taylor Olsen 4197212238: "we will get a
 * lot of upset customers if they get the wrong portrait"). Two revisions went
 * to her after Auto QC said they missed her ask: 14 Oct "partly" (photo booth
 * still missing, the tattoos QC had removed were back), 18 Oct "no" (a different
 * photo drawn, booth still missing). Approve passed both. She saw three very
 * different portraits, none what she asked for, and asked for her money back.
 *
 * A QC pass whose file Auto QC judged as a revision "partly" or "not" done is
 * refused until staff either fail it back to the designer or give a reason to
 * send it anyway (logged on the order). Over the 21 days before this, buyers
 * asked again after 75% of "no" and 65% of "partly" revisions that went out,
 * against 38% of "yes".
 *
 * Only Auto QC's newest check counts, and only when it judged exactly the files
 * going out now: a newer upload waits for its own check. Designers never pass
 * QC, so they never see this; `system` roads are not stopped (same as the
 * wrong-file stop).
 */
import { desc, eq } from "drizzle-orm";

import type { RequestUser, Tx } from "@/lib/db";
import { activityLog, autoQcChecks, orders } from "@/lib/db/schema";
import { orderNumberOf } from "@/lib/orders/same-buyer";
import { sameIds } from "@/lib/qc/auto-qc";
import { MIN_OVERRIDE_REASON } from "@/lib/qc/wrong-file";

export const REVISION_STOP_OVERRIDE_ACTION = "order.revision_stop_override";

export type RevisionStopRefusal = { code: "revision_not_done"; message: string };

export type RevisionStopCheck = {
  id?: string;
  assetIds: unknown;
  revision: unknown;
};

export type RevisionStop = { done: "no" | "partly"; missed: string[]; note: string | null; autoQcId: string | null };

/** The stop Auto QC's newest check puts on these outgoing files, or null when they may go. */
export function evaluateRevisionStop(check: RevisionStopCheck | null | undefined, outgoing: string[]): RevisionStop | null {
  if (!check) return null;
  // Exactly the files going out, the screens' "current" rule: after a newer upload, its own check decides.
  if (!sameIds(check.assetIds, [...new Set(outgoing)])) return null;
  const rv = check.revision && typeof check.revision === "object" ? (check.revision as Record<string, unknown>) : null;
  if (!rv || (rv.done !== "no" && rv.done !== "partly")) return null;
  const missed = Array.isArray(rv.missed)
    ? rv.missed.filter((m): m is string => typeof m === "string" && m.trim().length > 0).map((m) => m.trim())
    : [];
  return { done: rv.done, missed, note: typeof rv.note === "string" && rv.note.trim() ? rv.note.trim() : null, autoQcId: check.id ?? null };
}

export function revisionStopMessage(stop: RevisionStop, orderNumber: string | null): string {
  const who = orderNumber ? `Order ${orderNumber}: ` : "";
  const what = stop.done === "no" ? "this revision was not done" : "this revision is only partly done";
  const missed = stop.missed.length ? ` Missed: ${stop.missed.slice(0, 4).join("; ")}.` : stop.note ? ` ${stop.note}` : "";
  return `${who}Auto QC says ${what}.${missed} Fail it back to the designer with these notes, or send it anyway only if you have checked it does what the customer asked.`;
}

/**
 * The gate every QC pass runs: null when the outgoing files may go (no stop, or
 * staff gave an override reason, which is logged on the order), else a refusal
 * with the plain message.
 */
export async function revisionStopGate(
  tx: Tx,
  actor: { id: string; role: RequestUser["role"] | "system" },
  input: { orderId: string; businessId: string; assetIds: string[]; overrideReason?: unknown; via: "qc_pass" },
): Promise<RevisionStopRefusal | null> {
  if (actor.role === "system" || !input.assetIds.length) return null;
  const [check] = await tx
    .select({ id: autoQcChecks.id, assetIds: autoQcChecks.assetIds, revision: autoQcChecks.revision })
    .from(autoQcChecks)
    .where(eq(autoQcChecks.orderId, input.orderId))
    .orderBy(desc(autoQcChecks.createdAt))
    .limit(1);
  const stop = evaluateRevisionStop(check, input.assetIds);
  if (!stop) return null;

  const reason = typeof input.overrideReason === "string" ? input.overrideReason.trim().replace(/\s+/g, " ").slice(0, 500) : "";
  if ((actor.role === "admin" || actor.role === "va") && reason.length >= MIN_OVERRIDE_REASON) {
    await tx.insert(activityLog).values({
      businessId: input.businessId,
      orderId: input.orderId,
      actorId: actor.id,
      action: REVISION_STOP_OVERRIDE_ACTION,
      metadata: { reason, via: input.via, done: stop.done, missed: stop.missed, autoQcId: stop.autoQcId },
    });
    return null;
  }
  const [order] = await tx
    .select({ platformOrderName: orders.platformOrderName, platformOrderId: orders.platformOrderId })
    .from(orders)
    .where(eq(orders.id, input.orderId));
  return { code: "revision_not_done", message: revisionStopMessage(stop, order ? orderNumberOf(order) : null) };
}
