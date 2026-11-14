import { eq, sql } from "drizzle-orm";

import type { Tx } from "@/lib/db";
import { orderItems, printJobs } from "@/lib/db/schema";

/**
 * Digital orders close on the buyer's yes (Yousif 2026-11-06: "Autocomplete
 * digital orders once the buyer approves but they can still ask for touchups
 * at a later date"). Once she approves a digital proof nothing is owed, so the
 * order moves approved -> complete in the same transaction and leaves every
 * board, the print queue and the Overdue view. A later change request still
 * works: complete -> in_design is a revision edge (lib/orders/transitions.ts),
 * the Orders page offers it, and the designer's clock restarts from that day.
 *
 * The rule is pure so it can be tested without a database; the loader reads
 * the two facts it needs.
 */
export type AutoCompleteInput = {
  items: { productType: "digital" | "physical" }[];
  printJobs: number;
};

export type AutoCompleteVerdict = { eligible: true } | { eligible: false; why: string };

export function digitalAutoCompleteVerdict(input: AutoCompleteInput): AutoCompleteVerdict {
  if (input.items.length === 0) return { eligible: false, why: "no order items yet" };
  const physical = input.items.filter((i) => i.productType === "physical").length;
  if (physical > 0) {
    return { eligible: false, why: `${physical} physical line${physical === 1 ? "" : "s"} still ${physical === 1 ? "has" : "have"} to print and ship` };
  }
  if (input.printJobs > 0) return { eligible: false, why: "a print job exists for this order" };
  return { eligible: true };
}

export async function loadAutoCompleteInput(tx: Tx, orderId: string): Promise<AutoCompleteInput> {
  const [items, [jobs]] = await Promise.all([
    tx.select({ productType: orderItems.productType }).from(orderItems).where(eq(orderItems.orderId, orderId)),
    tx.select({ n: sql<number>`count(*)::int` }).from(printJobs).where(eq(printJobs.orderId, orderId)),
  ]);
  return { items, printJobs: jobs?.n ?? 0 };
}

/**
 * Nightly sweep (also the one-off backfill): every approved all-digital order
 * closes as complete. An order the inline hook held (its figure count was
 * unresolved) gets one more try at inferring the count first, so setting a
 * shop rule or fixing the item closes it on the next sweep without a person
 * touching the order. Held orders are reported, never forced.
 */
export type SweepSummary = {
  approved: number;
  eligible: number;
  closed: { orderId: string; number: string; business: string }[];
  held: { orderId: string; number: string; business: string; reason: string }[];
  stayed: number;
};

export async function closeApprovedDigital(opts: { limit?: number; businessFilter?: string | null } = {}): Promise<SweepSummary> {
  const { and, desc, inArray } = await import("drizzle-orm");
  const { withSystemContext } = await import("@/lib/db");
  const { activityLog, businesses, orders } = await import("@/lib/db/schema");
  const { autoResolveOrderFigures } = await import("./figure-auto");
  const { OrderTransitionError, transitionAsSystem } = await import("./transitions");
  const limit = opts.limit ?? Infinity;
  const filter = opts.businessFilter?.toLowerCase() ?? null;

  const rows = await withSystemContext(async (tx) => {
    const base = await tx
      .select({
        id: orders.id,
        number: sql<string>`coalesce(${orders.platformOrderName}, ${orders.platformOrderId})`,
        business: businesses.name,
      })
      .from(orders)
      .innerJoin(businesses, eq(businesses.id, orders.businessId))
      .where(eq(orders.status, "approved"))
      .orderBy(orders.createdAt);
    const ids = base.map((r) => r.id);
    if (!ids.length) return [];
    const [items, jobs, approvals] = await Promise.all([
      tx.select({ orderId: orderItems.orderId, productType: orderItems.productType }).from(orderItems).where(inArray(orderItems.orderId, ids)),
      tx.select({ orderId: printJobs.orderId, n: sql<number>`count(*)::int` }).from(printJobs).where(inArray(printJobs.orderId, ids)).groupBy(printJobs.orderId),
      tx
        .select({ orderId: activityLog.orderId, at: sql<string>`max(${activityLog.createdAt})::text` })
        .from(activityLog)
        // A held or edit row (approved -> approved) is not an approval: it must never move the earning period.
        .where(
          and(
            inArray(activityLog.orderId, ids),
            eq(activityLog.toState, "approved"),
            sql`${activityLog.fromState} IS DISTINCT FROM 'approved'`,
          ),
        )
        .groupBy(activityLog.orderId),
    ]);
    const itemsBy = new Map<string, { productType: "digital" | "physical" }[]>();
    for (const i of items) itemsBy.set(i.orderId, [...(itemsBy.get(i.orderId) ?? []), i]);
    const jobsBy = new Map(jobs.map((j) => [j.orderId, j.n]));
    const approvedBy = new Map(approvals.map((a) => [a.orderId as string, a.at]));
    void desc;
    return base.map((r) => ({
      ...r,
      approvedAt: approvedBy.get(r.id) ?? null,
      verdict: digitalAutoCompleteVerdict({ items: itemsBy.get(r.id) ?? [], printJobs: jobsBy.get(r.id) ?? 0 }),
    }));
  });

  const scoped = filter ? rows.filter((r) => r.business.toLowerCase().includes(filter)) : rows;
  const eligible = scoped.filter((r) => r.verdict.eligible);
  const out: SweepSummary = { approved: scoped.length, eligible: eligible.length, closed: [], held: [], stayed: scoped.length - eligible.length };
  for (const r of eligible) {
    if (out.closed.length >= limit) break;
    try {
      await withSystemContext((tx) => autoResolveOrderFigures(tx, r.id));
      await transitionAsSystem({
        orderId: r.id,
        to: "complete",
        expectedFrom: "approved",
        autoClose: "digital",
        metadata: { via: "auto_complete_digital_backfill", ...(r.approvedAt ? { completedAt: new Date(r.approvedAt).toISOString() } : {}) },
      });
      out.closed.push({ orderId: r.id, number: r.number, business: r.business });
    } catch (e) {
      if (!(e instanceof OrderTransitionError)) throw e;
      out.held.push({ orderId: r.id, number: r.number, business: r.business, reason: e.message });
    }
  }
  return out;
}

/**
 * A digital order closes even when its figure count is unknown; its earning then waits
 * blocked as "Missing figure count." This retries inference for those orders (bounded) and,
 * when a count is found, resolves the earning through the same path the Payouts page uses.
 */
export type BlockedFigureRetry = { checked: number; resolved: { orderId: string; number: string; amount: string }[]; stillBlocked: number };

export async function retryBlockedFigureEarnings(opts: { limit?: number } = {}): Promise<BlockedFigureRetry> {
  const { and, eq } = await import("drizzle-orm");
  const { withSystemContext } = await import("@/lib/db");
  const { earnings, orders } = await import("@/lib/db/schema");
  const { autoResolveOrderFigures } = await import("./figure-auto");
  const { recalculateBlockedEarning } = await import("./earnings");
  const limit = opts.limit ?? 50;

  const rows = await withSystemContext((tx) =>
    tx
      .select({
        id: earnings.id,
        orderId: earnings.orderId,
        businessId: earnings.businessId,
        number: sql<string>`coalesce(${orders.platformOrderName}, ${orders.platformOrderId})`,
      })
      .from(earnings)
      .innerJoin(orders, eq(orders.id, earnings.orderId))
      .where(and(eq(earnings.status, "blocked"), eq(earnings.blockedReason, "Missing figure count.")))
      .orderBy(earnings.createdAt)
      .limit(limit),
  );
  const out: BlockedFigureRetry = { checked: rows.length, resolved: [], stillBlocked: 0 };
  for (const r of rows) {
    const done = await withSystemContext(async (tx) => {
      if ((await autoResolveOrderFigures(tx, r.orderId)) > 0) return null;
      const res = await recalculateBlockedEarning(tx, r.id, r.businessId);
      return res.ok ? res.amount : null;
    });
    if (done) out.resolved.push({ orderId: r.orderId, number: r.number, amount: done });
    else out.stillBlocked++;
  }
  return out;
}
