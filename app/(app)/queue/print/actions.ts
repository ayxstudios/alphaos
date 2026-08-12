"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { withUserContext, type RequestUser } from "@/lib/db";
import { activityLog, orders } from "@/lib/db/schema";
import {
  formatShippingAddress,
  isShippingAddressComplete,
  upsertOrderShippingAddress,
} from "@/lib/shipping/address";
import type { PrintProvider } from "@/lib/print/mapping";
import { OrderTransitionError } from "@/lib/orders/transitions";
import { recordManualPrintSignal } from "@/lib/print/manual";

export type PrintActionResult = { ok: true; message: string } | { ok: false; message: string };

async function requireStaff(): Promise<RequestUser | { error: string }> {
  const session = await auth();
  const role = session?.user?.role;
  if (!session?.user || (role !== "admin" && role !== "va")) {
    return { error: "Only admin and VAs can manage print fulfilment." };
  }
  return { id: session.user.id, role };
}

function clean(value: FormDataEntryValue | null): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}

function cleanProvider(value: FormDataEntryValue | null): PrintProvider | null {
  return value === "gelato" || value === "lumaprints" ? value : null;
}

export async function saveOrderShippingAddress(formData: FormData): Promise<PrintActionResult> {
  const user = await requireStaff();
  if ("error" in user) return { ok: false, message: user.error };
  const orderId = clean(formData.get("orderId"));
  if (!orderId) return { ok: false, message: "Order is required." };

  const result = await withUserContext(user, async (tx) => {
    const [order] = await tx
      .select({ id: orders.id, businessId: orders.businessId })
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);
    if (!order) return { ok: false as const, message: "Order not found." };

    const address = {
      name: clean(formData.get("name")),
      company: clean(formData.get("company")),
      addressLine1: clean(formData.get("addressLine1")),
      addressLine2: clean(formData.get("addressLine2")),
      city: clean(formData.get("city")),
      state: clean(formData.get("state")),
      postalCode: clean(formData.get("postalCode")),
      countryCode: clean(formData.get("countryCode")),
      phone: clean(formData.get("phone")),
      email: clean(formData.get("email")),
    };
    if (!isShippingAddressComplete(address)) {
      return { ok: false as const, message: "Name, address line 1, city, postal code, and country are required." };
    }

    await upsertOrderShippingAddress(tx, {
      businessId: order.businessId,
      orderId,
      source: "manual",
      address,
    });
    await tx.insert(activityLog).values({
      businessId: order.businessId,
      orderId,
      actorId: user.id,
      action: "order.shipping_address_saved",
      metadata: { via: "print_queue", lines: formatShippingAddress(address).length },
    });
    return { ok: true as const, message: "Shipping address saved." };
  });

  revalidatePath("/queue/print");
  revalidatePath(`/orders/${orderId}`);
  return result;
}

export async function createManualPrintJob(formData: FormData): Promise<PrintActionResult> {
  const user = await requireStaff();
  if ("error" in user) return { ok: false, message: user.error };
  const orderId = clean(formData.get("orderId"));
  const provider = cleanProvider(formData.get("provider"));
  if (!orderId) return { ok: false, message: "Order is required." };
  if (!provider) return { ok: false, message: "Choose Gelato or Luma Prints." };

  try {
    const result = await withUserContext(user, async (tx) => {
      return recordManualPrintSignal(tx, user, { orderId, provider });
    });

    revalidatePath("/queue/print");
    revalidatePath(`/orders/${orderId}`);
    revalidatePath("/orders");
    revalidatePath("/board");
    return result;
  } catch (error) {
    if (error instanceof OrderTransitionError) return { ok: false, message: error.message };
    throw error;
  }
}
