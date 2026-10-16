import { and, desc, eq, isNull, sql } from "drizzle-orm";

import type { Tx } from "@/lib/db";
import { assets, assignments, designerBusinesses, designerProfiles, orders, users } from "@/lib/db/schema";

/**
 * Revisions and failed QC stay with their designer (Yousif 2026-10-16: "don't
 * move revisions or failed QC to another designer unless I approve it. It can
 * confuse designers and often they need the source file").
 *
 * An order is REWORK once it has been drawn: revision_count > 0 (a buyer
 * change or a failed QC) or a submission is on file. A rework order may only
 * go to the designer of its latest assignment row or to the designer who
 * uploaded its latest submission (the person with the source file; a VA
 * uploading for someone does not count). Anyone else needs an
 * owner's approval: an admin making the move, or a caller passing
 * ownerApproved. Migration 0063 (trigger assignments_rework_stays) holds the
 * same line in the database for every writer, ad-hoc SQL included; approval
 * reaches it as the transaction-local setting alphaos.rework_move_ok.
 */
export type ReworkHold = {
  rework: boolean;
  revisionCount: number;
  hasSubmission: boolean;
  /** Designer on the order's latest assignment row, active or not. */
  lastDesignerId: string | null;
  /** Designer who uploaded the latest submission still on file: the person with the source file. */
  drewId: string | null;
};

export const REWORK_MOVE_SETTING = "alphaos.rework_move_ok";

/** Thrown by createAssignment when a revision or failed QC would go to someone new without an owner's approval. */
export class ReworkStaysError extends Error {
  readonly code = "rework_stays";
}

/** The trigger's refusal (migration 0063), for callers that catch a database error (Drizzle wraps it as the cause). */
export function isReworkStaysDbError(e: unknown): boolean {
  for (let cur = e, depth = 0; cur != null && depth < 5; cur = (cur as { cause?: unknown }).cause, depth++) {
    if (/\brework_stays\b/.test(cur instanceof Error ? cur.message : String(cur))) return true;
  }
  return false;
}

export async function loadReworkHold(tx: Tx, orderId: string): Promise<ReworkHold> {
  const [o] = await tx.select({ revisionCount: orders.revisionCount }).from(orders).where(eq(orders.id, orderId)).limit(1);
  // The active row wins a tie on created_at (two rows in one transaction), so
  // this is never looser than the trigger, which accepts any row at the latest time.
  const [last] = await tx
    .select({ designerId: assignments.designerId })
    .from(assignments)
    .where(eq(assignments.orderId, orderId))
    .orderBy(desc(assignments.assignedAt), desc(assignments.active))
    .limit(1);
  const subs = await tx
    .select({ uploadedBy: assets.uploadedBy, role: users.role })
    .from(assets)
    .leftJoin(users, eq(users.id, assets.uploadedBy))
    .where(and(eq(assets.orderId, orderId), eq(assets.type, "submission"), isNull(assets.deletedAt)))
    .orderBy(desc(assets.createdAt));
  const revisionCount = o?.revisionCount ?? 0;
  return {
    rework: revisionCount > 0 || subs.length > 0,
    revisionCount,
    hasSubmission: subs.length > 0,
    lastDesignerId: last?.designerId ?? null,
    drewId: subs.find((s) => s.uploadedBy && s.role === "designer")?.uploadedBy ?? null,
  };
}

/**
 * Is the order bound to its designer? Rework with somebody to keep it: a
 * revision nobody in AlphaOS ever held or drew (an import) routes as usual. Pure.
 */
export function reworkBound(hold: ReworkHold): boolean {
  return hold.rework && !!(hold.lastDesignerId || hold.drewId);
}

/** May this designer have the order without an owner's approval? Pure. */
export function reworkAllows(hold: ReworkHold, designerId: string): boolean {
  if (!reworkBound(hold)) return true;
  return designerId === hold.lastDesignerId || designerId === hold.drewId;
}

export type ReworkKeeper = { designerId: string; name: string | null; isAgent: boolean };

/**
 * Who a rework order goes back to: the designer of its latest assignment, else
 * whoever drew it, while they still design for this business. humanOnly (an
 * order AI Studio gave up on) asks for the person who drew it first and never
 * AI Studio. Null = nobody may take it without an owner's approval.
 */
export async function reworkKeeper(
  tx: Tx,
  businessId: string,
  hold: ReworkHold,
  opts: { humanOnly?: boolean } = {},
): Promise<ReworkKeeper | null> {
  const order = opts.humanOnly ? [hold.drewId, hold.lastDesignerId] : [hold.lastDesignerId, hold.drewId];
  for (const id of order) {
    if (!id) continue;
    const [d] = await tx
      .select({ designerId: users.id, name: users.name, isAgent: designerProfiles.isAgent })
      .from(users)
      .innerJoin(designerBusinesses, and(eq(designerBusinesses.userId, users.id), eq(designerBusinesses.businessId, businessId)))
      .leftJoin(designerProfiles, eq(designerProfiles.userId, users.id))
      .where(and(eq(users.id, id), eq(users.role, "designer"), eq(users.active, true)))
      .limit(1);
    if (!d || (opts.humanOnly && d.isAgent)) continue;
    return { designerId: d.designerId, name: d.name, isAgent: !!d.isAgent };
  }
  return null;
}

/** The name of whoever the rework belongs to (the person who drew it, else the last designer). */
export async function reworkOwnerName(tx: Tx, hold: ReworkHold): Promise<string | null> {
  const id = hold.drewId ?? hold.lastDesignerId;
  if (!id) return null;
  const [u] = await tx.select({ name: users.name }).from(users).where(eq(users.id, id)).limit(1);
  return u?.name ?? null;
}

export async function reworkStaysMessage(tx: Tx, hold: ReworkHold): Promise<string> {
  const who = await reworkOwnerName(tx, hold);
  return `This is a revision or failed QC, so it stays with ${who ?? "the designer who drew it"} (they have the source file). Moving it to someone else needs an owner's approval.`;
}

/** The admin making a move, as their approval of it; null for anyone else (VA, designer, system, nobody). */
export async function adminApproval(tx: Tx, userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const [u] = await tx.select({ name: users.name, role: users.role, active: users.active }).from(users).where(eq(users.id, userId)).limit(1);
  return u?.role === "admin" && u.active ? `${u.name ?? "admin"} (${userId})` : null;
}

/** Let the trigger accept the next assignment write in this transaction ("" closes it again). */
export async function setReworkMoveApproval(tx: Tx, approvedBy: string): Promise<void> {
  await tx.execute(sql`select set_config(${REWORK_MOVE_SETTING}, ${approvedBy}, true)`);
}
