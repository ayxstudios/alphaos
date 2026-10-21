import { and, eq, sql } from "drizzle-orm";

import type { Tx } from "@/lib/db";
import { assignments, designerProfiles, users } from "@/lib/db/schema";

/**
 * An order stays on its designer's board (Yousif 2026-10-21: "Some designers
 * are saying some orders disappear from their alphaOS boards, can we make sure
 * this stops happening. You shouldn't really reassign orders unless they are
 * severely late or we've talked about it here").
 *
 * Once a person has the order (its active assignment is a designer who is not
 * AI Studio, on a login that is still active), nothing gives it to anyone else
 * without an owner's approval: an admin making the move, or a caller passing
 * ownerApproved (who, and their words). No automatic pass moves it, whatever
 * the load, the hour or how long it has waited: a late order stays with its
 * designer until an owner says who takes it. AI Studio's orders and a
 * deactivated designer's orders move freely, and a first assignment is untouched.
 * Migration 0064 (trigger assignments_stay_on_board) holds the same line in
 * the database for every writer, ad-hoc SQL included; the approval reaches it
 * as the transaction-local setting alphaos.rework_move_ok (lib/orders/rework.ts).
 */
export type BoardHolder = {
  designerId: string;
  name: string | null;
  isAgent: boolean;
  /** The designer's login is active (a deactivated designer's work may move). */
  loginActive: boolean;
  assignedAt: Date;
};

/**
 * A hand-back to the designer who already has the order (a fresh row and
 * deadline) is marked for the database guard as "<order id>:<designer id>",
 * so it never opens the guard for anyone else.
 */
export const BOARD_HAND_BACK_SETTING = "alphaos.board_move_ok";

/** Thrown by createAssignment when an order would leave a person's board without an owner's approval. */
export class StaysOnBoardError extends Error {
  readonly code = "stays_on_board";
}

/** The trigger's refusal (migration 0064), for callers that catch a database error (Drizzle wraps it as the cause). */
export function isStaysOnBoardDbError(e: unknown): boolean {
  for (let cur = e, depth = 0; cur != null && depth < 5; cur = (cur as { cause?: unknown }).cause, depth++) {
    if (/\bstays_on_board\b/.test(cur instanceof Error ? cur.message : String(cur))) return true;
  }
  return false;
}

/** Who has the order on their board now: the designer of its active assignment, or null when nobody does. */
export async function loadBoardHolder(tx: Tx, orderId: string): Promise<BoardHolder | null> {
  const [row] = await tx
    .select({
      designerId: assignments.designerId,
      name: users.name,
      loginActive: users.active,
      isAgent: designerProfiles.isAgent,
      assignedAt: assignments.assignedAt,
    })
    .from(assignments)
    .innerJoin(users, eq(users.id, assignments.designerId))
    .leftJoin(designerProfiles, eq(designerProfiles.userId, assignments.designerId))
    .where(and(eq(assignments.orderId, orderId), eq(assignments.active, true)))
    .limit(1);
  if (!row) return null;
  return {
    designerId: row.designerId,
    name: row.name,
    isAgent: !!row.isAgent,
    loginActive: row.loginActive,
    assignedAt: new Date(row.assignedAt),
  };
}

/** Is the order on a person's board, so it may leave it only with an owner's approval? Pure. */
export function onPersonsBoard(holder: BoardHolder | null): holder is BoardHolder {
  return !!holder && !holder.isAgent && holder.loginActive;
}

/** Would giving the order to designerId take it off a person's board? Pure. */
export function boardHolds(holder: BoardHolder | null, designerId: string): boolean {
  return onPersonsBoard(holder) && holder.designerId !== designerId;
}

export function staysOnBoardMessage(holder: BoardHolder | null): string {
  return `This order is on ${holder?.name ?? "its designer"}'s board, so it stays with them. Moving it to someone else needs an owner's approval.`;
}

/** Let the database guard accept handing this order back to the designer who has it (null closes it again). */
export async function setBoardHandBack(tx: Tx, orderId: string, designerId: string | null): Promise<void> {
  await tx.execute(sql`select set_config(${BOARD_HAND_BACK_SETTING}, ${designerId ? `${orderId}:${designerId}` : ""}, true)`);
}
