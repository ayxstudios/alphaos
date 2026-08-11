"use server";

import { revalidatePath } from "next/cache";
import { and, eq, sql } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { withUserContext, type RequestUser } from "@/lib/db";
import { activityLog, earnings } from "@/lib/db/schema";
import { recalculateBlockedEarning } from "@/lib/orders/earnings";

export type ActionResult = { ok: true; message: string } | { ok: false; message: string };

async function requireAdmin(): Promise<RequestUser | null> {
  const session = await auth();
  if (!session?.user) return null;
  if (session.user.role !== "admin") return null;
  return { id: session.user.id, role: session.user.role };
}

export async function resolveBlockedEarningAction(earningId: string, businessId: string): Promise<ActionResult> {
  const user = await requireAdmin();
  if (!user) return { ok: false, message: "Not permitted" };

  const result = await withUserContext(user, async (tx) => {
    const result = await recalculateBlockedEarning(tx, earningId, businessId);
    if (!result.ok) return result;
    const [earning] = await tx
      .select({ orderId: earnings.orderId })
      .from(earnings)
      .where(eq(earnings.id, earningId));
    await tx.insert(activityLog).values({
      businessId,
      orderId: earning?.orderId ?? null,
      actorId: user.id,
      action: "earning.resolved",
      metadata: { amount: result.amount },
    });
    return { ok: true as const, message: `Resolved at $${Number(result.amount).toFixed(2)}` };
  });

  revalidatePath("/payouts");
  revalidatePath("/board");
  return result;
}

export async function markPeriodPaidAction(
  businessId: string,
  designerId: string,
  period: string,
): Promise<ActionResult> {
  const user = await requireAdmin();
  if (!user) return { ok: false, message: "Not permitted" };
  if (!/^\d{4}-\d{2}$/.test(period)) return { ok: false, message: "Invalid period" };

  const result = await withUserContext(user, async (tx) => {
    const [summary] = await tx
      .select({
        count: sql<number>`count(*)::int`,
        total: sql<string>`coalesce(sum(${earnings.amount}), 0)`,
      })
      .from(earnings)
      .where(
        and(
          eq(earnings.businessId, businessId),
          eq(earnings.designerId, designerId),
          eq(earnings.period, period),
          eq(earnings.status, "pending"),
        ),
      );
    if (!summary || summary.count === 0) return { ok: false as const, message: "No pending earnings to mark paid" };

    await tx
      .update(earnings)
      .set({ status: "paid", paidAt: new Date(), paidBy: user.id })
      .where(
        and(
          eq(earnings.businessId, businessId),
          eq(earnings.designerId, designerId),
          eq(earnings.period, period),
          eq(earnings.status, "pending"),
        ),
      );

    await tx.insert(activityLog).values({
      businessId,
      actorId: user.id,
      action: "earnings.period_paid",
      metadata: { designerId, period, count: summary.count, amount: summary.total },
    });
    return {
      ok: true as const,
      message: `Marked ${summary.count} earning${summary.count === 1 ? "" : "s"} paid`,
    };
  });

  revalidatePath("/payouts");
  revalidatePath("/board");
  return result;
}

export async function voidEarningAction(
  businessId: string,
  earningId: string,
  reasonRaw: string,
): Promise<ActionResult> {
  const user = await requireAdmin();
  if (!user) return { ok: false, message: "Not permitted" };
  const reason = reasonRaw.trim();
  if (!reason) return { ok: false, message: "Enter a void reason" };

  const result = await withUserContext(user, async (tx) => {
    const [earning] = await tx
      .select({ orderId: earnings.orderId, status: earnings.status })
      .from(earnings)
      .where(and(eq(earnings.id, earningId), eq(earnings.businessId, businessId)));
    if (!earning) return { ok: false as const, message: "Earning not found" };
    if (earning.status !== "blocked" && earning.status !== "pending") {
      return { ok: false as const, message: "Only blocked or pending earnings can be voided" };
    }

    await tx
      .update(earnings)
      .set({ status: "voided", voidedAt: new Date(), voidedBy: user.id, voidReason: reason })
      .where(eq(earnings.id, earningId));
    await tx.insert(activityLog).values({
      businessId,
      orderId: earning.orderId,
      actorId: user.id,
      action: "earning.voided",
      metadata: { reason },
    });
    return { ok: true as const, message: "Earning voided" };
  });

  revalidatePath("/payouts");
  revalidatePath("/board");
  return result;
}
