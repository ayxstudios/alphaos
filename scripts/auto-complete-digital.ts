/**
 * Backfill: approved all-digital orders close as complete (Yousif 2026-11-06,
 * "Autocomplete digital orders once the buyer approves"). New approvals close
 * themselves inside the transition (lib/orders/auto-complete.ts); this walks the
 * orders approved before that shipped.
 *
 *   npm run auto-complete-digital            dry run: counts + the held list, nothing written
 *   npm run auto-complete-digital -- --apply  closes them (system actor, via auto_complete_digital_backfill)
 *   --limit N  stop after N closes   --business <name fragment>  one shop only
 *
 * Each close is the normal approved -> complete transition, so the designer's
 * earning is created in the month the buyer approved (metadata.completedAt), and
 * an order whose figure count is unresolved stays approved and is listed.
 */
import "./load-env";

import { writeFileSync, mkdirSync } from "node:fs";
import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { withSystemContext } from "../lib/db";
import { activityLog, businesses, orderItems, orders, printJobs } from "../lib/db/schema";
import { digitalAutoCompleteVerdict } from "../lib/orders/auto-complete";
import { OrderTransitionError, transitionAsSystem } from "../lib/orders/transitions";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const limitAt = args.indexOf("--limit");
const limit = limitAt >= 0 ? Number(args[limitAt + 1]) : Infinity;
const bizAt = args.indexOf("--business");
const bizFilter = bizAt >= 0 ? String(args[bizAt + 1]).toLowerCase() : null;

type Row = {
  id: string;
  number: string;
  business: string;
  archived: boolean;
  approvedAt: string | null;
  verdict: ReturnType<typeof digitalAutoCompleteVerdict>;
  unresolvedFigures: boolean;
};

async function main() {
  const rows = await withSystemContext(async (tx) => {
    const base = await tx
      .select({
        id: orders.id,
        number: sql<string>`coalesce(${orders.platformOrderName}, ${orders.platformOrderId})`,
        business: businesses.name,
        archivedAt: orders.archivedAt,
      })
      .from(orders)
      .innerJoin(businesses, eq(businesses.id, orders.businessId))
      .where(eq(orders.status, "approved"))
      .orderBy(orders.createdAt);
    const ids = base.map((r) => r.id);
    if (!ids.length) return [] as Row[];
    const [items, jobs, approvals] = await Promise.all([
      tx.select({ orderId: orderItems.orderId, productType: orderItems.productType, figureCount: orderItems.figureCount }).from(orderItems).where(inArray(orderItems.orderId, ids)),
      tx.select({ orderId: printJobs.orderId, n: sql<number>`count(*)::int` }).from(printJobs).where(inArray(printJobs.orderId, ids)).groupBy(printJobs.orderId),
      tx
        .select({ orderId: activityLog.orderId, at: sql<string>`max(${activityLog.createdAt})::text` })
        .from(activityLog)
        .where(and(inArray(activityLog.orderId, ids), eq(activityLog.toState, "approved")))
        .groupBy(activityLog.orderId),
    ]);
    const itemsBy = new Map<string, typeof items>();
    for (const i of items) itemsBy.set(i.orderId, [...(itemsBy.get(i.orderId) ?? []), i]);
    const jobsBy = new Map(jobs.map((j) => [j.orderId, j.n]));
    const approvedBy = new Map(approvals.map((a) => [a.orderId!, a.at]));
    return base.map((r): Row => {
      const its = itemsBy.get(r.id) ?? [];
      return {
        id: r.id,
        number: r.number,
        business: r.business,
        archived: !!r.archivedAt,
        approvedAt: approvedBy.get(r.id) ?? null,
        verdict: digitalAutoCompleteVerdict({ items: its, printJobs: jobsBy.get(r.id) ?? 0 }),
        unresolvedFigures: its.some((i) => i.figureCount == null),
      };
    });
  });

  const scoped = bizFilter ? rows.filter((r) => r.business.toLowerCase().includes(bizFilter)) : rows;
  const eligible = scoped.filter((r) => r.verdict.eligible);
  const skipped = scoped.filter((r) => !r.verdict.eligible);
  const byBiz = (list: Row[]) => {
    const m = new Map<string, number>();
    for (const r of list) m.set(r.business, (m.get(r.business) ?? 0) + 1);
    return Object.fromEntries([...m.entries()].sort((a, b) => b[1] - a[1]));
  };
  console.log(`approved orders: ${scoped.length}; all-digital, nothing at a printer: ${eligible.length}`, byBiz(eligible));
  console.log(`stay approved (physical line or print job): ${skipped.length}`, byBiz(skipped));
  console.log(`eligible but figure count unresolved (may be held): ${eligible.filter((r) => r.unresolvedFigures).length}`);

  const closed: Row[] = [];
  const held: (Row & { reason: string })[] = [];
  if (apply) {
    for (const r of eligible) {
      if (closed.length >= limit) break;
      try {
        await transitionAsSystem({
          orderId: r.id,
          to: "complete",
          expectedFrom: "approved",
          metadata: { via: "auto_complete_digital_backfill", ...(r.approvedAt ? { completedAt: new Date(r.approvedAt).toISOString() } : {}) },
        });
        closed.push(r);
      } catch (e) {
        if (!(e instanceof OrderTransitionError)) throw e;
        held.push({ ...r, reason: e.message });
      }
    }
    console.log(`closed: ${closed.length}`, byBiz(closed));
    console.log(`held: ${held.length}`);
    for (const h of held) console.log(`  ${h.business} ${h.number}: ${h.reason}`);
  } else {
    console.log("dry run; pass --apply to close them");
  }
  const dir = `${process.env.HOME}/Documents/ai-employee-agent/var/alphaos-auto-complete`;
  mkdirSync(dir, { recursive: true });
  const out = `${dir}/${new Date().toISOString().replace(/[:.]/g, "-")}-${apply ? "apply" : "dry"}.json`;
  writeFileSync(out, JSON.stringify({ apply, eligible, skipped, closed, held }, null, 2));
  console.log(`report: ${out}`);
  void desc;
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
