"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { withUserContext, type RequestUser } from "@/lib/db";
import { orderItems, orders, activityLog } from "@/lib/db/schema";

/** Manually resolve a line item's figure count (VA/admin), from the review queue. */
export async function setItemFigureCount(
  orderItemId: string,
  count: number,
): Promise<void> {
  const session = await auth();
  const role = session?.user?.role;
  if (!session?.user || (role !== "admin" && role !== "va")) {
    throw new Error("Forbidden");
  }
  if (!Number.isInteger(count) || count < 1 || count > 50) {
    throw new Error("Enter a whole number between 1 and 50");
  }
  const user: RequestUser = { id: session.user.id, role };

  await withUserContext(user, async (tx) => {
    const [item] = await tx
      .update(orderItems)
      .set({ figureCount: count, figureCountSource: "manual" })
      .where(eq(orderItems.id, orderItemId))
      .returning({ orderId: orderItems.orderId, businessId: orderItems.businessId });
    if (!item) throw new Error("Item not found");

    // Clear the order's review flag once no figures remain unresolved.
    const unresolved = await tx
      .select({ id: orderItems.id })
      .from(orderItems)
      .where(
        and(
          eq(orderItems.orderId, item.orderId),
          eq(orderItems.figureCountSource, "unresolved"),
        ),
      );
    const cleared = unresolved.length === 0;
    if (cleared) {
      await tx
        .update(orders)
        .set({ needsReview: false, updatedAt: new Date() })
        .where(eq(orders.id, item.orderId));
    }

    await tx.insert(activityLog).values({
      businessId: item.businessId,
      orderId: item.orderId,
      actorId: user.id,
      action: "order.figure_resolved",
      metadata: { orderItemId, figureCount: count, clearedReview: cleared },
    });
  });

  revalidatePath("/queue/review");
}
