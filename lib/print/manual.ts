import { eq } from "drizzle-orm";

import type { RequestUser, Tx } from "@/lib/db";
import { activityLog, orderItems, orders, printJobs } from "@/lib/db/schema";
import { runTransition, type OrderStatus } from "@/lib/orders/transitions";
import type { PrintProvider } from "@/lib/print/mapping";

export async function recordManualPrintSignal(
  tx: Tx,
  user: RequestUser,
  input: { orderId: string; provider: PrintProvider },
): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
  const [order] = await tx
    .select({
      id: orders.id,
      businessId: orders.businessId,
      status: orders.status,
      number: orders.platformOrderName,
      fallbackNumber: orders.platformOrderId,
    })
    .from(orders)
    .where(eq(orders.id, input.orderId))
    .for("update")
    .limit(1);
  if (!order) return { ok: false, message: "Order not found." };
  if (order.status !== "approved") {
    return { ok: false, message: "Only approved physical orders can be sent to print." };
  }

  const itemRows = await tx
    .select({ productType: orderItems.productType })
    .from(orderItems)
    .where(eq(orderItems.orderId, input.orderId));
  const physicalItems = itemRows.filter((item) => item.productType === "physical");
  if (!physicalItems.length) return { ok: false, message: "This order has no physical items to print." };

  const now = new Date();
  await tx.insert(printJobs).values({
    businessId: order.businessId,
    orderId: input.orderId,
    provider: input.provider,
    method: "manual",
    status: "sent_to_print",
    submittedAt: now,
    providerPayload: {
      source: "manual_provider_dashboard",
      platformOrderNumber: order.number ?? order.fallbackNumber,
      physicalItemCount: physicalItems.length,
      triggeredBy: user.id,
    },
  });
  await tx.insert(activityLog).values({
    businessId: order.businessId,
    orderId: input.orderId,
    actorId: user.id,
    action: "print.manual_started",
    metadata: {
      provider: input.provider,
      via: "print_queue",
      orderNumber: order.number ?? order.fallbackNumber,
    },
  });
  await runTransition(tx, user, {
    orderId: input.orderId,
    to: "printing",
    expectedFrom: order.status as OrderStatus,
    metadata: { via: "print_queue_manual_start", provider: input.provider },
  });
  return { ok: true, message: "Sent-to-print signal recorded." };
}
