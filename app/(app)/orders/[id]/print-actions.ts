"use server";

// The one tap on the order page's "Print and ship" card (docs/AGENT_FIRST.md
// 3.2). The agent already prepared the provider order (lib/print/prepare.ts);
// this submits it as the staff member who tapped.
import { revalidatePath } from "next/cache";

import { auth } from "@/lib/auth";
import type { PrintProvider } from "@/lib/print/mapping";
import { submitPrintOrder } from "@/lib/print/submit";

export type SubmitPrintActionResult = { ok: true; message: string } | { ok: false; message: string };

export async function submitPrintOrderAction(
  orderId: string,
  provider: PrintProvider | null = null,
): Promise<SubmitPrintActionResult> {
  const session = await auth();
  const role = session?.user?.role;
  if (!session?.user || (role !== "admin" && role !== "va")) return { ok: false, message: "Not permitted" };
  if (provider !== null && provider !== "lumaprints" && provider !== "gelato") {
    return { ok: false, message: "Unknown print provider." };
  }
  try {
    const result = await submitPrintOrder({ orderId, actorUserId: session.user.id, actorRole: role, provider });
    revalidatePath(`/orders/${orderId}`);
    return result.ok ? { ok: true, message: result.message } : { ok: false, message: result.message };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Could not submit the print order." };
  }
}
