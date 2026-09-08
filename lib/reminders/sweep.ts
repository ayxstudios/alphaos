import { and, eq, inArray, isNull, lte } from "drizzle-orm";

import { withSystemContext, type Tx } from "@/lib/db";
import { orders, orderItems, proofs, reminderFires } from "@/lib/db/schema";
import { queuePhotoReminder, queueStageEmail } from "@/lib/email/dispatch";
import { approveProof } from "@/lib/proofs/decide";
import { proofUrl } from "@/lib/urls";
import { sendAlphaEvent } from "@/lib/alpha/client";

const DAY = 24 * 60 * 60 * 1000;
export const PHOTO_REMINDER_AFTER_MS = 48 * 60 * 60 * 1000; // 48h
export const PROOF_REMINDER_AFTER_MS = 3 * DAY;
export const CUSTOMER_SILENT_AFTER_MS = 5 * DAY;
export const AUTO_APPROVE_AFTER_MS = 7 * DAY;
export const AUTO_APPROVE_REASON = "auto-approved after 7 days of silence (terms)";

export type ReminderKind =
  | "photo_reminder"
  | "proof_reminder"
  | "customer_silent_alpha"
  | "proof_auto_approve";

export type RemindersSweepResult = {
  photoReminders: { candidates: number; fired: number };
  proofReminders: { candidates: number; fired: number };
  customerSilentAlerts: { candidates: number; fired: number };
  autoApprovals: { candidates: number; fired: number; failed: number };
};

/**
 * Claim a reminder fire before doing the side effect it guards (email send,
 * Alpha event, auto-approve). One row per (kind, subject) EVER, however many
 * times the cron overlaps or re-runs (reminder_fires.dedupe_key is unique) —
 * same "claim first" idempotency pattern as notification_fires. Runs inside
 * the same transaction as the side effect: if the side effect throws, the
 * whole transaction (claim included) rolls back and the next sweep retries;
 * if the side effect succeeds and is itself the source of truth (e.g. a
 * proof getting a decision), the claim persists and this never re-fires.
 */
async function claim(
  tx: Tx,
  args: { businessId: string; orderId: string | null; kind: ReminderKind; subjectId: string; metadata?: Record<string, unknown> },
): Promise<boolean> {
  const dedupeKey = `${args.kind}:${args.subjectId}`;
  const [row] = await tx
    .insert(reminderFires)
    .values({
      businessId: args.businessId,
      orderId: args.orderId,
      kind: args.kind,
      subjectId: args.subjectId,
      dedupeKey,
      metadata: args.metadata ?? {},
    })
    .onConflictDoNothing({ target: reminderFires.dedupeKey })
    .returning({ id: reminderFires.id });
  return !!row;
}

/**
 * The reminders sweep (lib/CLAUDE.md "customer window"): 48h photo reminder,
 * 3-day proof reminder, a day-5 `customer.silent` heads-up to the VA, and the
 * 7-day silence rule (a physical order's unanswered proof auto-approves per
 * our terms, so print/ship isn't held hostage by an unresponsive customer —
 * digital orders are never auto-approved). Safe to call as often as you like;
 * every side effect is claimed exactly once via reminder_fires.
 */
export async function runRemindersSweep(opts: { businessIds?: string[]; now?: Date } = {}): Promise<RemindersSweepResult> {
  const now = opts.now ?? new Date();
  const bizFilter = opts.businessIds?.length ? inArray(orders.businessId, opts.businessIds) : undefined;

  const result: RemindersSweepResult = {
    photoReminders: { candidates: 0, fired: 0 },
    proofReminders: { candidates: 0, fired: 0 },
    customerSilentAlerts: { candidates: 0, fired: 0 },
    autoApprovals: { candidates: 0, fired: 0, failed: 0 },
  };

  // --- 48h photo reminder --------------------------------------------------
  const photoCutoff = new Date(now.getTime() - PHOTO_REMINDER_AFTER_MS);
  const photoCandidates = await withSystemContext((tx) =>
    tx
      .select({
        id: orders.id,
        businessId: orders.businessId,
        customerId: orders.customerId,
        platformOrderId: orders.platformOrderId,
        platformOrderName: orders.platformOrderName,
        uploadToken: orders.uploadToken,
      })
      .from(orders)
      .where(
        and(
          eq(orders.status, "awaiting_photos"),
          isNull(orders.archivedAt),
          lte(orders.createdAt, photoCutoff),
          ...(bizFilter ? [bizFilter] : []),
        ),
      ),
  );
  result.photoReminders.candidates = photoCandidates.length;
  for (const order of photoCandidates) {
    if (!order.uploadToken) continue;
    const fired = await withSystemContext(async (tx) => {
      const claimed = await claim(tx, { businessId: order.businessId, orderId: order.id, kind: "photo_reminder", subjectId: order.id });
      if (!claimed) return false;
      await queuePhotoReminder(tx, {
        id: order.id,
        businessId: order.businessId,
        customerId: order.customerId,
        platformOrderId: order.platformOrderId,
        platformOrderName: order.platformOrderName,
        uploadToken: order.uploadToken!,
      });
      return true;
    });
    if (fired) result.photoReminders.fired++;
  }

  // --- proof-based: 3-day reminder, day-5 silent alert, day-7 auto-approve -
  const proofCandidates = await withSystemContext((tx) =>
    tx
      .select({
        proofId: proofs.id,
        token: proofs.token,
        sentAt: proofs.sentAt,
        orderId: orders.id,
        businessId: orders.businessId,
        customerId: orders.customerId,
        platformOrderId: orders.platformOrderId,
        platformOrderName: orders.platformOrderName,
      })
      .from(proofs)
      .innerJoin(orders, eq(orders.id, proofs.orderId))
      .where(
        and(
          isNull(proofs.decision),
          eq(orders.status, "awaiting_approval"),
          isNull(orders.archivedAt),
          ...(bizFilter ? [bizFilter] : []),
        ),
      ),
  );
  const withSentAt = proofCandidates.filter((p): p is typeof p & { sentAt: Date } => p.sentAt != null);

  // Physical-vs-digital: an order auto-approves on silence only when it has at
  // least one physical line item (digital work is never sent to press, so
  // there's no fulfilment deadline forcing the decision).
  const orderIds = [...new Set(withSentAt.map((p) => p.orderId))];
  const physicalOrderIds = new Set<string>();
  if (orderIds.length) {
    const items = await withSystemContext((tx) =>
      tx
        .select({ orderId: orderItems.orderId })
        .from(orderItems)
        .where(and(inArray(orderItems.orderId, orderIds), eq(orderItems.productType, "physical"))),
    );
    for (const it of items) physicalOrderIds.add(it.orderId);
  }

  for (const p of withSentAt) {
    const ageMs = now.getTime() - p.sentAt.getTime();
    const order = {
      id: p.orderId,
      businessId: p.businessId,
      customerId: p.customerId,
      platformOrderId: p.platformOrderId,
      platformOrderName: p.platformOrderName,
    };

    if (ageMs >= PROOF_REMINDER_AFTER_MS) {
      result.proofReminders.candidates++;
      const fired = await withSystemContext(async (tx) => {
        const claimed = await claim(tx, { businessId: p.businessId, orderId: p.orderId, kind: "proof_reminder", subjectId: p.proofId });
        if (!claimed) return false;
        await queueStageEmail(tx, order, "proof_reminder", { proof_link: proofUrl(p.token) });
        return true;
      });
      if (fired) result.proofReminders.fired++;
    }

    if (ageMs >= CUSTOMER_SILENT_AFTER_MS) {
      result.customerSilentAlerts.candidates++;
      const fired = await withSystemContext(async (tx) => {
        const claimed = await claim(tx, { businessId: p.businessId, orderId: p.orderId, kind: "customer_silent_alpha", subjectId: p.proofId });
        if (!claimed) return false;
        await sendAlphaEvent(tx, {
          type: "customer.silent",
          businessId: p.businessId,
          orderId: p.orderId,
          toRole: "va",
          text: `Customer hasn't responded to their proof for order ${order.platformOrderName ?? order.platformOrderId} in 5 days.`,
          payload: { orderUrl: `/orders/${p.orderId}`, proofLink: proofUrl(p.token) },
        });
        return true;
      });
      if (fired) result.customerSilentAlerts.fired++;
    }

    if (ageMs >= AUTO_APPROVE_AFTER_MS && physicalOrderIds.has(p.orderId)) {
      result.autoApprovals.candidates++;
      const claimed = await withSystemContext((tx) =>
        claim(tx, { businessId: p.businessId, orderId: p.orderId, kind: "proof_auto_approve", subjectId: p.proofId }),
      );
      if (claimed) {
        const res = await approveProof(p.token, {
          via: "reminders_sweep_silence",
          metadata: { autoApproveReason: AUTO_APPROVE_REASON },
        });
        if (res.ok) result.autoApprovals.fired++;
        else result.autoApprovals.failed++;
      }
    }
  }

  return result;
}
