import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";

import type { Tx } from "@/lib/db";
import { messages, orders } from "@/lib/db/schema";
import { STALE_AFTER_DAYS } from "./backlog-constants";

/**
 * Backlog guard for the moment a business turns customer email sending ON.
 *
 * While sending is off, system emails keep piling up: photo requests and
 * reminders as `queued` (the auto flush sends them as soon as sending is on)
 * and stage emails as `draft`. Turning sending on must not greet a buyer whose
 * order finished weeks ago. So, in the same transaction that flips the switch,
 * every unsent system email that is now stale is marked SKIPPED:
 *
 *   - `queued` rows move to `draft`, so the auto flush never sends them;
 *   - `draft` rows stay drafts;
 *   - both get `metadata.skippedOnEnable = { at, reason, fromStatus }`, which
 *     the Emails outbox shows as a "Skipped" badge with the reason.
 *
 * Nothing is deleted. A VA can still "Approve & send" (the reversal) or
 * "Discard" each one from Messages > Waiting to send.
 */

export { STALE_AFTER_DAYS };
const DAY_MS = 24 * 60 * 60 * 1000;

/** Order states after which no customer email from the backlog makes sense. */
const TERMINAL_ORDER_STATES = new Set(["complete", "cancelled", "delivered"]);
/** Intake emails: stale once the order itself is older than the window. */
const INTAKE_TEMPLATES = new Set(["order_received", "photo_request", "photo_reminder"]);

export type SkippedOnEnable = { at: string; reason: string; fromStatus: "queued" | "draft" };

export type BacklogCandidate = {
  status: string;
  templateKey: string | null;
  createdAt: Date;
  orderStatus: string | null;
  orderArchivedAt: Date | null;
  orderPlacedAt: Date | null;
  orderCreatedAt: Date | null;
};

/** Why an unsent system email is stale at switch-on, or null if it may still go. */
export function staleReason(c: BacklogCandidate, now: Date): string | null {
  if (c.orderStatus && TERMINAL_ORDER_STATES.has(c.orderStatus)) return `order is already ${c.orderStatus}`;
  if (c.orderArchivedAt) return "order is archived";
  const msgAgeDays = Math.floor((now.getTime() - c.createdAt.getTime()) / DAY_MS);
  if (msgAgeDays >= STALE_AFTER_DAYS) return `email waited ${msgAgeDays} days unsent`;
  const placed = c.orderPlacedAt ?? c.orderCreatedAt;
  if (placed && c.templateKey && INTAKE_TEMPLATES.has(c.templateKey)) {
    const orderAgeDays = Math.floor((now.getTime() - placed.getTime()) / DAY_MS);
    if (orderAgeDays >= STALE_AFTER_DAYS) return `order was placed ${orderAgeDays} days ago`;
  }
  return null;
}

/**
 * Mark stale unsent system emails for one business as skipped. Runs inside the
 * caller's transaction (the admin's withUserContext in the settings action).
 * Returns how many were skipped and how many queued rows were held back.
 */
export async function skipStaleBacklog(
  tx: Tx,
  businessId: string,
  now: Date = new Date(),
): Promise<{ skipped: number; heldFromQueue: number }> {
  const rows = await tx
    .select({
      id: messages.id,
      status: messages.status,
      templateKey: messages.templateKey,
      createdAt: messages.createdAt,
      metadata: messages.metadata,
      orderStatus: orders.status,
      orderArchivedAt: orders.archivedAt,
      orderPlacedAt: orders.placedAt,
      orderCreatedAt: orders.createdAt,
    })
    .from(messages)
    .leftJoin(orders, eq(orders.id, messages.orderId))
    .where(
      and(
        eq(messages.businessId, businessId),
        eq(messages.direction, "outbound"),
        inArray(messages.status, ["queued", "draft"]),
        isNotNull(messages.templateKey),
        isNull(messages.archivedAt),
      ),
    );

  let skipped = 0;
  let heldFromQueue = 0;
  for (const r of rows) {
    const meta = (r.metadata ?? {}) as Record<string, unknown>;
    if (meta.skippedOnEnable) continue; // already marked on an earlier switch-on
    const reason = staleReason(r, now);
    if (!reason) continue;
    const mark: SkippedOnEnable = {
      at: now.toISOString(),
      reason,
      fromStatus: r.status === "queued" ? "queued" : "draft",
    };
    await tx
      .update(messages)
      .set({
        status: "draft",
        metadata: sql`coalesce(${messages.metadata}, '{}'::jsonb) || ${JSON.stringify({ skippedOnEnable: mark })}::jsonb`,
      })
      .where(eq(messages.id, r.id));
    skipped++;
    if (r.status === "queued") heldFromQueue++;
  }
  return { skipped, heldFromQueue };
}
