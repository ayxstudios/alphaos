"use server";

// Server actions for "Ask Alpha" — the one-question helper shown on every
// order card and in the top bar. Talks to Alpha through the single contract
// module (lib/alpha/client.ts) only; never reaches the daemon directly.
import { eq } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { withUserContext, type RequestUser } from "@/lib/db";
import { businesses, customers, orderItems, orders, shops } from "@/lib/db/schema";
import { askAlpha } from "@/lib/alpha/client";
import { addComment } from "@/lib/orders/card-detail";

export type AskAlphaResult =
  | { ok: true; answer: string; escalated: boolean; connected: boolean }
  | { ok: false; message: string };

async function requireUser(): Promise<(RequestUser & { name: string }) | null> {
  const session = await auth();
  if (!session?.user) return null;
  return { id: session.user.id, role: session.user.role, name: session.user.name ?? "Someone" };
}

/**
 * Ask Alpha a question, optionally scoped to one order. Order context is kept
 * intentionally thin — number, shop, status, item options, figure count, and
 * the customer's FIRST name only (never email or last name; designers never
 * see either). With no order, Alpha answers from general house rules only.
 * The question and answer are logged as an order comment when there is an
 * order, so the exchange is visible in the activity feed for everyone else.
 */
export async function askAlphaAboutOrder(orderId: string | null, questionRaw: string): Promise<AskAlphaResult> {
  const user = await requireUser();
  if (!user) return { ok: false, message: "Not signed in" };
  const question = questionRaw.trim();
  if (!question) return { ok: false, message: "Type a question first" };
  if (question.length > 2000) return { ok: false, message: "That question is too long" };

  let businessId: string | null = null;
  let context: Record<string, unknown> = {};

  if (orderId) {
    const found = await withUserContext(user, async (tx) => {
      const [order] = await tx
        .select({
          businessId: orders.businessId,
          number: orders.platformOrderName,
          fallbackNumber: orders.platformOrderId,
          status: orders.status,
          shopName: shops.name,
          customerFirst: customers.firstName,
          businessName: businesses.name,
        })
        .from(orders)
        .innerJoin(shops, eq(shops.id, orders.shopId))
        .innerJoin(businesses, eq(businesses.id, orders.businessId))
        .leftJoin(customers, eq(customers.id, orders.customerId))
        .where(eq(orders.id, orderId));
      if (!order) return null;
      const items = await tx
        .select({ options: orderItems.options, figureCount: orderItems.figureCount })
        .from(orderItems)
        .where(eq(orderItems.orderId, orderId));
      return { order, items };
    });
    if (found) {
      businessId = found.order.businessId;
      const figureCount = found.items.reduce((sum, it) => sum + (it.figureCount ?? 0), 0);
      const options = found.items.flatMap((it) => (Array.isArray(it.options) ? it.options : []));
      context = {
        orderNumber: found.order.number ?? found.order.fallbackNumber,
        shop: found.order.shopName,
        businessName: found.order.businessName,
        status: found.order.status,
        itemOptions: options,
        figureCount,
        customerFirstName: found.order.customerFirst?.trim().split(/\s+/)[0] ?? null,
      };
    }
  }

  const answer = await askAlpha({
    question,
    askedBy: { userId: user.id, role: user.role, name: user.name },
    businessId,
    orderId,
    context,
  });

  if (orderId) {
    await addComment(
      user,
      orderId,
      `Asked Alpha: "${question}"\n\nAlpha: ${answer.answer}`,
    ).catch(() => {
      /* the answer still reached the person asking even if logging fails */
    });
  }

  return { ok: true, answer: answer.answer, escalated: answer.escalated, connected: answer.connected };
}
