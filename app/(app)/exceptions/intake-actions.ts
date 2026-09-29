"use server";

import { revalidatePath } from "next/cache";

import { auth } from "@/lib/auth";
import { confirmLegacyOrder, pickDesignerForProduct } from "@/lib/agent/legacy-intake";
import type { RequestUser } from "@/lib/db";

type Result = { ok: true; message: string } | { ok: false; message: string };

async function requireStaff(): Promise<RequestUser | null> {
  const session = await auth();
  const role = session?.user?.role;
  if (!session?.user || (role !== "admin" && role !== "va")) return null;
  return { id: session.user.id, role };
}

/** The legacy card's confirm form: stub becomes a normal order. */
export async function confirmLegacyOrderAction(input: {
  exceptionId: string;
  style: string;
  figureCount: number | null;
  productType: "digital" | "physical";
  dueAt: string;
  productTitle?: string;
  customerName?: string;
  customerEmail?: string;
  notes?: string;
}): Promise<Result> {
  const user = await requireStaff();
  if (!user) return { ok: false, message: "Only staff can confirm orders" };
  const res = await confirmLegacyOrder(user, input);
  revalidatePath("/exceptions");
  if (!res.ok) return res;
  return {
    ok: true,
    message: res.toStatus === "ready_to_assign" ? "Confirmed. The order is being assigned." : "Confirmed. Waiting on photos.",
  };
}

/** The new-product card's designer picker: saves the mapping for future orders. */
export async function pickProductDesignerAction(exceptionId: string, designerId: string): Promise<Result> {
  const user = await requireStaff();
  if (!user) return { ok: false, message: "Only staff can pick a designer" };
  if (!designerId) return { ok: false, message: "Pick a designer first." };
  const res = await pickDesignerForProduct(user, { exceptionId, designerId });
  revalidatePath("/exceptions");
  if (!res.ok) return res;
  return { ok: true, message: `${res.designerName} now draws ${res.styleName}. Future orders route to them.` };
}
