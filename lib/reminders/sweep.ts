import { and, eq, inArray, isNull, lte, sql } from "drizzle-orm";

import { withSystemContext, type Tx } from "@/lib/db";
import { orders, proofs, reminderFires } from "@/lib/db/schema";
import { queuePhotoReminder, queueStageEmail } from "@/lib/email/dispatch";
import { proofUrl } from "@/lib/urls";
import { sendAlphaEvent } from "@/lib/alpha/client";
import { agentOrderScope, legacyQuiet } from "@/lib/agent/scope";
import { buyerRepliedSince } from "./buyer-replied";
import { printShipOrderIds } from "./print-ship";

const DAY = 24 * 60 * 60 * 1000;
export const PHOTO_REMINDER_AFTER_MS = 48 * 60 * 60 * 1000; // 48h
export const PROOF_REMINDER_AFTER_MS = 3 * DAY;
export const CUSTOMER_SILENT_AFTER_MS = 5 * DAY;

export type ReminderKind = "photo_reminder" | "proof_reminder" | "customer_silent_alpha";

export type RemindersSweepResult = {
  photoReminders: { candidates: number; fired: number };
  proofReminders: { candidates: number; fired: number };
  customerSilentAlerts: { candidates: number; fired: number };
  /** Proofs left alone because the buyer wrote after them: a reply is not silence. */
  buyerReplied: number;
  /** Digital proofs left in the buyer's court: no reminder, no silent alert. */
  digitalLeftAlone: number;
};

/**
 * Claim a reminder fire before doing the side effect it guards (email send,
 * Alpha event). One row per (kind, subject) EVER, however many
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
 * and for a PRINT AND SHIP proof a 3-day reminder plus a day-5
 * `customer.silent` heads-up to the VA. Safe to call as often as you like;
 * every side effect is claimed exactly once via reminder_fires.
 *
 * Nothing is ever approved on silence and a digital proof is never followed up
 * (Yousif 2026-10-31: "We also shouldn't be following up on email for digital
 * items ... Just leave it in their court. Even print and ship orders shouldn't
 * go out without final approval from the customer."). The day-7 silence
 * auto-approve that used to send a physical proof to print is gone.
 *
 * A legacy order its buyer has not reached out on (legacyQuiet, scope.ts) gets
 * none of these: no photo or proof reminder and no silent alert. Nothing is
 * claimed for it, so the day it is no longer quiet it starts its own clock.
 */
export async function runRemindersSweep(opts: { businessIds?: string[]; now?: Date } = {}): Promise<RemindersSweepResult> {
  const now = opts.now ?? new Date();
  const bizFilter = opts.businessIds?.length ? inArray(orders.businessId, opts.businessIds) : undefined;

  const result: RemindersSweepResult = {
    photoReminders: { candidates: 0, fired: 0 },
    proofReminders: { candidates: 0, fired: 0 },
    customerSilentAlerts: { candidates: 0, fired: 0 },
    buyerReplied: 0,
    digitalLeftAlone: 0,
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
          agentOrderScope(),
          sql`not ${legacyQuiet()}`,
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

  // --- proof-based (print and ship only): 3-day reminder, day-5 silent alert -
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
          agentOrderScope(),
          sql`not ${legacyQuiet()}`,
          ...(bizFilter ? [bizFilter] : []),
        ),
      ),
  );
  const withSentAt = proofCandidates.filter((p): p is typeof p & { sentAt: Date } => p.sentAt != null);

  // A digital proof is in the buyer's court: no reminder and no silent alert.
  const printShip = await withSystemContext((tx) => printShipOrderIds(tx, withSentAt.map((p) => p.orderId)));

  for (const p of withSentAt) {
    const ageMs = now.getTime() - p.sentAt.getTime();
    if (!printShip.has(p.orderId)) {
      if (ageMs >= PROOF_REMINDER_AFTER_MS) result.digitalLeftAlone++;
      continue;
    }
    const order = {
      id: p.orderId,
      businessId: p.businessId,
      customerId: p.customerId,
      platformOrderId: p.platformOrderId,
      platformOrderName: p.platformOrderName,
    };

    // The buyer wrote after this proof (an approval, a change request, a
    // question): no reminder and no "customer silent" alert. Shelby Leachet 4199624202 got a
    // reminder 45 min after asking for changes (clean slating audit,
    // 2026-10-16). Nothing is claimed, so a newer proof starts its own clock.
    if (ageMs >= PROOF_REMINDER_AFTER_MS) {
      const replied = await withSystemContext((tx) => buyerRepliedSince(tx, p.orderId, p.sentAt));
      if (replied) {
        result.buyerReplied++;
        continue;
      }
    }

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
          text: `Customer hasn't responded to their print proof for order ${order.platformOrderName ?? order.platformOrderId} in 5 days. It is not printed until they approve it.`,
          payload: { orderUrl: `/orders/${p.orderId}`, proofLink: proofUrl(p.token) },
        });
        return true;
      });
      if (fired) result.customerSilentAlerts.fired++;
    }

  }

  return result;
}
