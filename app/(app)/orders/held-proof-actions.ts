"use server";

import { revalidatePath } from "next/cache";

import { auth } from "@/lib/auth";
import { withUserContext } from "@/lib/db";
import { sendHeldProofNow } from "@/lib/orders/deliver-together-db";

export type SendNowResult = { ok: true; message: string } | { ok: false; message: string };

/**
 * "Send now" on a proof held to go with the buyer's other order
 * (lib/orders/deliver-together.ts): it goes at once, the same way the hold
 * would have let it go. Owners and VAs (the ones who approve customer email).
 */
export async function sendHeldProofNowAction(orderId: string): Promise<SendNowResult> {
  const session = await auth();
  const role = session?.user?.role;
  if (!session?.user || (role !== "admin" && role !== "va")) return { ok: false, message: "Only owners and VAs can send a proof." };
  const user = { id: session.user.id, role };
  const res = await sendHeldProofNow((fn) => withUserContext(user, fn), orderId, user.id);
  revalidatePath(`/orders/${orderId}`);
  revalidatePath("/orders");
  revalidatePath("/emails");
  if (!res.ok) return { ok: false, message: res.message };
  if (res.closed) return { ok: true, message: "It was already sent or the order moved on, so nothing more went out." };
  return { ok: true, message: res.sent ? "Proof sent to the buyer." : "It is already on its way." };
}
