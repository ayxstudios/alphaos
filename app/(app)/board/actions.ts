"use server";

import { revalidatePath } from "next/cache";

import { auth } from "@/lib/auth";
import {
  transition,
  OrderTransitionError,
  type OrderStatus,
} from "@/lib/orders/transitions";

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
    revalidatePath("/queue");
    return { ok: true, status };
  } catch (err) {
    if (err instanceof OrderTransitionError) {
      return { ok: false, code: err.code, message: err.message };
    }
    throw err;
  }
}
