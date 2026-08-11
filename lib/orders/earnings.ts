import { and, eq, inArray } from "drizzle-orm";

import type { Tx } from "@/lib/db";
import {
  assignments,
  earnings,
  orderItems,
  styles,
  type EarningBreakdown,
} from "@/lib/db/schema";

export type EarningCalculation = {
  figureCount: number;
  rate: string | null;
  amount: string | null;
  breakdown: EarningBreakdown[];
  status: "blocked" | "pending";
  blockedReason: string | null;
};

function centsFromRate(rate: string | null): number | null {
  if (rate == null) return null;
  const value = Number(rate);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.round(value * 100);
}

function money(cents: number): string {
  return (cents / 100).toFixed(2);
}

function unique(list: string[]): string[] {
  return [...new Set(list)];
}

export function currentPeriod(date = new Date()): string {
  return date.toISOString().slice(0, 7);
}

export async function calculateOrderEarning(
  tx: Tx,
  orderId: string,
  businessId: string,
): Promise<EarningCalculation> {
  const items = await tx
    .select({
      id: orderItems.id,
      figureCount: orderItems.figureCount,
      style: orderItems.style,
    })
    .from(orderItems)
    .where(and(eq(orderItems.orderId, orderId), eq(orderItems.businessId, businessId)));

  if (!items.length) {
    return {
      figureCount: 0,
      rate: null,
      amount: null,
      breakdown: [],
      status: "blocked",
      blockedReason: "Order has no items.",
    };
  }

  const styleNames = unique(items.map((item) => item.style?.trim()).filter((style): style is string => !!style));
  const styleRows = styleNames.length
    ? await tx
        .select({ name: styles.name, perFigureRate: styles.perFigureRate })
        .from(styles)
        .where(and(eq(styles.businessId, businessId), inArray(styles.name, styleNames)))
    : [];
  const ratesByStyle = new Map(styleRows.map((style) => [style.name.toLowerCase(), centsFromRate(style.perFigureRate)]));

  let totalFigures = 0;
  let totalCents = 0;
  const rateCents = new Set<number>();
  const blockedReasons: string[] = [];

  const breakdown = items.map((item): EarningBreakdown => {
    const figures = item.figureCount ?? 0;
    totalFigures += figures;

    let blockedReason: string | undefined;
    let cents: number | null = null;

    if (item.figureCount == null) {
      blockedReason = "Missing figure count.";
    } else if (!item.style?.trim()) {
      blockedReason = "Missing portrait style.";
    } else {
      cents = ratesByStyle.get(item.style.trim().toLowerCase()) ?? null;
      if (cents == null) blockedReason = `Style "${item.style}" needs a per-figure rate.`;
    }

    if (blockedReason) {
      blockedReasons.push(blockedReason);
      return {
        orderItemId: item.id,
        style: item.style,
        figureCount: figures,
        rate: null,
        amount: null,
        blockedReason,
      };
    }

    const payableCents = cents;
    if (payableCents == null) {
      throw new Error("Internal payout calculation error: missing payable rate");
    }
    rateCents.add(payableCents);
    totalCents += payableCents * figures;
    return {
      orderItemId: item.id,
      style: item.style,
      figureCount: figures,
      rate: money(payableCents),
      amount: money(payableCents * figures),
    };
  });

  if (blockedReasons.length) {
    return {
      figureCount: totalFigures,
      rate: null,
      amount: null,
      breakdown,
      status: "blocked",
      blockedReason: unique(blockedReasons).join(" "),
    };
  }

  return {
    figureCount: totalFigures,
    rate: rateCents.size === 1 ? money([...rateCents][0]) : null,
    amount: money(totalCents),
    breakdown,
    status: "pending",
    blockedReason: null,
  };
}

export async function createEarningForCompletion(
  tx: Tx,
  orderId: string,
  businessId: string,
): Promise<void> {
  const [assignment] = await tx
    .select({ designerId: assignments.designerId })
    .from(assignments)
    .where(and(eq(assignments.orderId, orderId), eq(assignments.active, true)));
  if (!assignment) return;

  const calculation = await calculateOrderEarning(tx, orderId, businessId);
  await tx
    .insert(earnings)
    .values({
      businessId,
      designerId: assignment.designerId,
      orderId,
      figureCount: calculation.figureCount,
      rate: calculation.rate,
      amount: calculation.amount,
      breakdown: calculation.breakdown,
      period: currentPeriod(),
      status: calculation.status,
      blockedReason: calculation.blockedReason,
    })
    .onConflictDoNothing({ target: earnings.orderId });
}

export async function recalculateBlockedEarning(
  tx: Tx,
  earningId: string,
  businessId: string,
): Promise<{ ok: true; amount: string } | { ok: false; message: string }> {
  const [earning] = await tx
    .select({ orderId: earnings.orderId, status: earnings.status })
    .from(earnings)
    .where(and(eq(earnings.id, earningId), eq(earnings.businessId, businessId)));
  if (!earning) return { ok: false, message: "Earning not found" };
  if (earning.status !== "blocked") return { ok: false, message: "Only blocked earnings can be resolved" };

  const calculation = await calculateOrderEarning(tx, earning.orderId, businessId);
  if (calculation.status === "blocked" || !calculation.amount) {
    return { ok: false, message: calculation.blockedReason ?? "Earning is still blocked" };
  }

  await tx
    .update(earnings)
    .set({
      figureCount: calculation.figureCount,
      rate: calculation.rate,
      amount: calculation.amount,
      breakdown: calculation.breakdown,
      status: "pending",
      blockedReason: null,
    })
    .where(eq(earnings.id, earningId));

  return { ok: true, amount: calculation.amount };
}
