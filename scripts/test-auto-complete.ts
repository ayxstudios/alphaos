/**
 * Digital orders close on the buyer's yes (lib/orders/auto-complete.ts).
 * Part 1 is pure. Part 2 approves a real awaiting_approval all-digital order inside
 * one transaction, checks it landed in complete with its earning and that a later
 * touchup (complete -> in_design) still works, then rolls everything back.
 * `npm run test:auto-complete`.
 */
import "./load-env";

import { and, desc, eq, sql } from "drizzle-orm";

import { withAlphaPushesHeld } from "../lib/alpha/client";
import { SYSTEM_ACTOR_ID, withSystemContext } from "../lib/db";
import { activityLog, earnings, orderItems, orders, printJobs } from "../lib/db/schema";
import { digitalAutoCompleteVerdict } from "../lib/orders/auto-complete";
import { autoResolveOrderFigures } from "../lib/orders/figure-auto";
import { recalculateBlockedEarning } from "../lib/orders/earnings";
import { PreconditionError, runTransition } from "../lib/orders/transitions";

let fails = 0;
const report = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) fails++;
};

const d = { productType: "digital" as const };
const p = { productType: "physical" as const };
report("one digital line: closes", digitalAutoCompleteVerdict({ items: [d], printJobs: 0 }).eligible);
report("two digital lines: closes", digitalAutoCompleteVerdict({ items: [d, d], printJobs: 0 }).eligible);
report("digital + print add-on: stays", !digitalAutoCompleteVerdict({ items: [d, p], printJobs: 0 }).eligible);
report("physical only: stays", !digitalAutoCompleteVerdict({ items: [p], printJobs: 0 }).eligible);
report("no items: stays", !digitalAutoCompleteVerdict({ items: [], printJobs: 0 }).eligible);
report("digital but a print job exists: stays", !digitalAutoCompleteVerdict({ items: [d], printJobs: 1 }).eligible);

class Rollback extends Error {}
const SYSTEM = { id: SYSTEM_ACTOR_ID, role: "system" as const };

async function dbRoundTrip() {
  try {
    await withAlphaPushesHeld(() =>
      withSystemContext(async (tx) => {
        const [cand] = await tx
          .select({ id: orders.id, number: orders.platformOrderId, revisionCount: orders.revisionCount })
          .from(orders)
          .where(
            and(
              eq(orders.status, "awaiting_approval"),
              sql`not exists (select 1 from ${orderItems} i where i.order_id = ${orders.id} and (i.product_type = 'physical' or i.figure_count is null))`,
              sql`exists (select 1 from ${orderItems} i where i.order_id = ${orders.id})`,
              sql`not exists (select 1 from ${printJobs} pj where pj.order_id = ${orders.id})`,
            ),
          )
          .orderBy(desc(orders.createdAt))
          .limit(1);
        if (!cand) {
          console.log("SKIP db: no awaiting_approval all-digital order to try on");
          throw new Rollback();
        }
        const res = await runTransition(tx, SYSTEM, { orderId: cand.id, to: "approved", expectedFrom: "awaiting_approval", metadata: { via: "test" } });
        report(`db ${cand.number}: approve returns complete`, res.status === "complete", res.status);
        const [o] = await tx.select({ status: orders.status }).from(orders).where(eq(orders.id, cand.id));
        report("db: order is complete", o.status === "complete", o.status);
        const log = await tx
          .select({ action: activityLog.action, from: activityLog.fromState, to: activityLog.toState, meta: activityLog.metadata })
          .from(activityLog)
          .where(eq(activityLog.orderId, cand.id))
          .orderBy(desc(activityLog.createdAt))
          .limit(2);
        const [last, prev] = log;
        report("db: approved then complete on the timeline", prev?.to === "approved" && last?.to === "complete" && last?.from === "approved", `${prev?.to} -> ${last?.to}`);
        report("db: complete row says auto_complete_digital", (last?.meta as { via?: string })?.via === "auto_complete_digital");
        const [earn] = await tx.select({ id: earnings.id }).from(earnings).where(eq(earnings.orderId, cand.id));
        report("db: earning created on completion", !!earn);
        // A later touchup: complete -> in_design is a revision, the designer's clock restarts.
        const rev = await runTransition(tx, SYSTEM, { orderId: cand.id, to: "in_design", expectedFrom: "complete", metadata: { via: "test", revisionReason: "test touchup" } });
        const [o2] = await tx.select({ status: orders.status, revisionCount: orders.revisionCount }).from(orders).where(eq(orders.id, cand.id));
        report("db: late touchup reopens the order", rev.status === "in_design" && o2.status === "in_design" && o2.revisionCount === cand.revisionCount + 1, `${o2.status} rev ${o2.revisionCount}`);
        throw new Rollback();
      }),
    );
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  // A physical order must stay approved.
  try {
    await withAlphaPushesHeld(() =>
      withSystemContext(async (tx) => {
        const [cand] = await tx
          .select({ id: orders.id, number: orders.platformOrderId })
          .from(orders)
          .where(
            and(
              eq(orders.status, "awaiting_approval"),
              sql`exists (select 1 from ${orderItems} i where i.order_id = ${orders.id} and i.product_type = 'physical')`,
            ),
          )
          .orderBy(desc(orders.createdAt))
          .limit(1);
        if (!cand) {
          console.log("SKIP db: no awaiting_approval physical order to try on");
          throw new Rollback();
        }
        const res = await runTransition(tx, SYSTEM, { orderId: cand.id, to: "approved", expectedFrom: "awaiting_approval", metadata: { via: "test" } });
        report(`db ${cand.number}: physical order stays approved`, res.status === "approved", res.status);
        throw new Rollback();
      }),
    );
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  // An all-digital order with an UNRESOLVED figure count still closes (Yousif 2026-11-14: "Digital approved but
  // not mark complete doesnt make sense"): the earning waits blocked, a person pressing Complete is still refused.
  try {
    await withAlphaPushesHeld(() =>
      withSystemContext(async (tx) => {
        const [cand] = await tx
          .select({ id: orders.id, number: orders.platformOrderId })
          .from(orders)
          .where(eq(orders.status, "awaiting_approval"))
          .orderBy(desc(orders.createdAt))
          .limit(1);
        if (!cand) {
          console.log("SKIP db: no awaiting_approval order for the unresolved-figure case");
          throw new Rollback();
        }
        await tx.delete(printJobs).where(eq(printJobs.orderId, cand.id));
        await tx
          .update(orderItems)
          .set({ productType: "digital", figureCount: null, figureCountSource: "unresolved", title: "Custom Pet Portrait", style: null, options: null, rawVariations: [] })
          .where(eq(orderItems.orderId, cand.id));
        await tx.update(orders).set({ rawImport: null }).where(eq(orders.id, cand.id));
        const res = await runTransition(tx, SYSTEM, { orderId: cand.id, to: "approved", expectedFrom: "awaiting_approval", metadata: { via: "test" } });
        report(`db ${cand.number}: approve with unresolved figures still returns complete`, res.status === "complete", res.status);
        const [o] = await tx.select({ status: orders.status }).from(orders).where(eq(orders.id, cand.id));
        report("db: unresolved-figure digital order is complete", o.status === "complete", o.status);
        const acts = await tx.select({ action: activityLog.action, from: activityLog.fromState, to: activityLog.toState }).from(activityLog).where(eq(activityLog.orderId, cand.id));
        report("db: no auto_complete_held row", !acts.some((a) => a.action === "order.auto_complete_held"));
        const pending = acts.find((a) => a.action === "order.auto_complete_figures_pending");
        report("db: auto_complete_figures_pending row, null states", !!pending && pending.from == null && pending.to == null);
        const [earn] = await tx.select({ id: earnings.id, status: earnings.status, reason: earnings.blockedReason }).from(earnings).where(eq(earnings.orderId, cand.id));
        report("db: earning is blocked 'Missing figure count.'", earn?.status === "blocked" && earn?.reason === "Missing figure count.", `${earn?.status} ${earn?.reason}`);

        // The nightly retry: once the options name a count, inference fills it, logs it, and the earning resolves.
        await tx.update(orderItems).set({ rawVariations: [{ name: "Options", value: "House & 3 Figure/pet" }] }).where(eq(orderItems.orderId, cand.id));
        const left = await autoResolveOrderFigures(tx, cand.id);
        const [it] = await tx.select({ n: orderItems.figureCount }).from(orderItems).where(eq(orderItems.orderId, cand.id));
        report("db: retry infers House & 3 Figure/pet = 4", left === 0 && it.n === 4, `left ${left}, count ${it.n}`);
        const auto = await tx.select({ meta: activityLog.metadata, from: activityLog.fromState }).from(activityLog).where(and(eq(activityLog.orderId, cand.id), eq(activityLog.action, "order.figure_count_auto")));
        report("db: one order.figure_count_auto row with the count", auto.length === 1 && (auto[0].meta as { count?: number })?.count === 4 && auto[0].from == null);
        const rec = await recalculateBlockedEarning(tx, earn.id, (await tx.select({ b: orders.businessId }).from(orders).where(eq(orders.id, cand.id)))[0].b);
        console.log(`INFO recalculateBlockedEarning: ${JSON.stringify(rec)}`);
        throw new Rollback();
      }),
    );
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  // A person (no autoClose flag) pressing Complete on an unresolved count keeps today's refusal.
  try {
    await withAlphaPushesHeld(() =>
      withSystemContext(async (tx) => {
        const [cand] = await tx.select({ id: orders.id }).from(orders).where(eq(orders.status, "approved")).limit(1);
        if (!cand) {
          console.log("SKIP db: no approved order for the manual-complete refusal");
          throw new Rollback();
        }
        await tx.update(orderItems).set({ figureCount: null, figureCountSource: "unresolved", title: "Custom Pet Portrait", style: null, options: null, rawVariations: [] }).where(eq(orderItems.orderId, cand.id));
        await tx.update(orders).set({ rawImport: null }).where(eq(orders.id, cand.id));
        let refused = false;
        try {
          await tx.transaction((sp) => runTransition(sp, SYSTEM, { orderId: cand.id, to: "complete", expectedFrom: "approved", metadata: { via: "test" } }));
        } catch (e) {
          refused = e instanceof PreconditionError;
        }
        report("db: manual Complete with unresolved figures is still refused", refused);
        throw new Rollback();
      }),
    );
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
}

dbRoundTrip().then(() => {
  if (fails) { console.error(`${fails} failing`); process.exit(1); }
  console.log("auto-complete: all pass");
  process.exit(0);
}, (e) => { console.error(e); process.exit(1); });
