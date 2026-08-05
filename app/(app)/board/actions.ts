"use server";

import { revalidatePath } from "next/cache";

import { auth } from "@/lib/auth";
import {
  transition,
  OrderTransitionError,
  type OrderStatus,
} from "@/lib/orders/transitions";
import {
  getCardDetail,
  addComment,
  type CardDetail,
  type CardEvent,
} from "@/lib/orders/card-detail";

export type MoveResult =
  | { ok: true; status: OrderStatus }
  | { ok: false; code: string; message: string };

/**
 * Move an order through the state machine. Every board drag / queue action calls
 * this — it's the single server entry point; `transition()` is the only writer of
 * orders.status. Returns a result object (never throws to the client) so the
 * board can revert the optimistic move and toast.
 */
export async function moveOrder(
  orderId: string,
  to: OrderStatus,
  expectedFrom: OrderStatus,
  metadata?: Record<string, unknown>,
): Promise<MoveResult> {
  const session = await auth();
  if (!session?.user) return { ok: false, code: "auth", message: "Not signed in" };
  const user = { id: session.user.id, role: session.user.role };

  try {
    const { status } = await transition(user, { orderId, to, expectedFrom, metadata });
    revalidatePath("/board");
    revalidatePath("/orders");
    return { ok: true, status };
  } catch (err) {
    if (err instanceof OrderTransitionError) {
      return { ok: false, code: err.code, message: err.message };
    }
    throw err;
  }
}

/** Lazy-load a card's history feed + images when its modal opens. */
export async function loadCard(orderId: string): Promise<CardDetail> {
  const session = await auth();
  if (!session?.user) throw new Error("Not signed in");
  const user = { id: session.user.id, role: session.user.role };
  return getCardDetail(user, orderId);
}

export type CommentResult =
  | { ok: true; event: CardEvent }
  | { ok: false; message: string };

/** Post a team comment (admin / VA / designer) onto a card's history. */
export async function postComment(orderId: string, body: string): Promise<CommentResult> {
  const session = await auth();
  if (!session?.user) return { ok: false, message: "Not signed in" };
  const text = body.trim();
  if (!text) return { ok: false, message: "Message is empty" };
  if (text.length > 5000) return { ok: false, message: "Message is too long" };
  const user = { id: session.user.id, role: session.user.role };
  const event = await addComment(user, orderId, text);
  revalidatePath("/board");
  return { ok: true, event };
}
