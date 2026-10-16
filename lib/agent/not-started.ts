// Not started on time: an order a designer was given notStartedMoveHours ago
// (default 24) and never started moves to a designer with room, chosen by the
// assigner's own ranking (style, business, daily limit, max active, per-style
// quota, rank: loadRankedCandidates), minus anyone away or already at their
// open-order limit (loadCapacityModel).
//
// Why (clean slating audit, 2026-10-16, deck af027ad3beb2831a, approved by the
// owner): orders sat with Abdul (103 open), Jerome (89) and Mar (57) for days
// with nobody drawing them, while the rebalance only moved work off designers
// who were over capacity or away, and skipped every assignment a login had
// placed. This supersedes the 2026-10-07 "auto-reassignment is off" note in
// lib/notifications/designer-sweep.ts for NOT-STARTED work only: that note was
// about throwing away work people do outside the app, so anything that shows a
// start is never moved here.
//
// "Not started" is narrow on purpose:
//   - the order is still ready_to_assign (Start was never pressed; designers
//     press it, 259 times in the week before the audit). in_design counts as
//     started whoever set it: a VA or owner setting it means someone said so.
//   - first pass (revisionCount 0), no submission on file (a drawn order is a
//     revision and stays with its designer, Yousif 2026-10-16), and no
//     timeline row by the assigned designer since this assignment (a comment,
//     an upload, anything they did on the order).
//   - the assignment is older than the clock.
// Kept where it is: an assignment an admin (owner) placed by hand, an order with
// no style (nobody guesses a style), and an order this pass already moved
// MAX_MOVES times (after that the stuck-order watch and the owner digest raise
// it; it does not tour every designer).
// Assignments placed by a VA login ("Alpha VA" is the agent's own login,
// "VA Team" the shared one: every active pin on 2026-10-16) move on this clock.
import { and, eq, lt, sql } from "drizzle-orm";

import { holdAlphaPushesIf } from "@/lib/alpha/client";
import { withSystemContext, type Tx } from "@/lib/db";
import { activityLog, assets, assignments, businesses, designerProfiles, orders, users } from "@/lib/db/schema";
import { businessSlaHours, createAssignment, loadRankedCandidates } from "@/lib/orders/assign";
import { liveOrderWhere } from "@/lib/orders/archive";
import { sendDesignerReassigned } from "@/lib/notifications/designer-events";

import { loadCapacityModel } from "./capacity";
import { getAgentConfig } from "./config";
import { handoverDueHours } from "./limbo";
import { agentOrderScope, legacyQuiet } from "./scope";

const HOUR = 60 * 60 * 1000;
/** Moves this pass makes on one order before leaving it to a person. */
export const MAX_NOT_STARTED_MOVES = 2;

export type NotStartedMove = {
  orderId: string;
  orderNumber: string;
  fromDesignerId: string;
  fromName: string;
  toDesignerId: string;
  toName: string;
  hoursWaited: number;
};

export type NotStartedReport = {
  dryRun: boolean;
  /** Orders past the clock that nobody started. */
  checked: number;
  moves: NotStartedMove[];
  /** An admin placed the assignment by hand: a human keeps it. */
  keptPinned: number;
  /** No style on the order: a person sets it first. */
  keptNoStyle: number;
  /** Already moved MAX_NOT_STARTED_MOVES times by this pass. */
  keptMovedEnough: number;
  /** Nobody else has room for it right now. */
  noTarget: number;
  errors: { orderId: string; message: string }[];
};

export const emptyNotStartedReport = (dryRun: boolean): NotStartedReport => ({
  dryRun,
  checked: 0,
  moves: [],
  keptPinned: 0,
  keptNoStyle: 0,
  keptMovedEnough: 0,
  noTarget: 0,
  errors: [],
});

class DryRunRollback extends Error {}

type Waiting = {
  orderId: string;
  orderNumber: string;
  dueAt: Date | null;
  assignmentId: string;
  designerId: string;
  designerName: string | null;
  assignedAt: Date;
  pinnedByAdmin: boolean;
  style: string | null;
  priorMoves: number;
};

/** Orders past the clock that the assigned person never started (see the header). */
export async function loadNotStarted(tx: Tx, businessId: string, olderThan: Date, orderId?: string): Promise<Waiting[]> {
  const rows = await tx
    .select({
      orderId: orders.id,
      name: orders.platformOrderName,
      platformOrderId: orders.platformOrderId,
      dueAt: orders.dueAt,
      assignmentId: assignments.id,
      designerId: assignments.designerId,
      designerName: users.name,
      assignedAt: assignments.assignedAt,
      pinnedByAdmin: sql<boolean>`exists (select 1 from "user" p where p.id = ${assignments.assignedBy} and p.role = 'admin')`,
      style: sql<string | null>`(select i.style from order_items i where i.order_id = ${orders.id} and i.style is not null order by i.id limit 1)`,
      priorMoves: sql<number>`(select count(*)::int from activity_log m where m.order_id = ${orders.id} and m.action = 'agent.not_started_moved')`,
    })
    .from(assignments)
    .innerJoin(orders, eq(orders.id, assignments.orderId))
    .innerJoin(users, eq(users.id, assignments.designerId))
    .innerJoin(designerProfiles, eq(designerProfiles.userId, assignments.designerId))
    .where(
      and(
        eq(assignments.active, true),
        eq(assignments.businessId, businessId),
        eq(designerProfiles.isAgent, false),
        lt(assignments.assignedAt, olderThan),
        eq(orders.status, "ready_to_assign"),
        eq(orders.revisionCount, 0),
        liveOrderWhere(),
        agentOrderScope(),
        // A legacy order its buyer has not reached out on stays where it is: moving it
        // pings a designer about a thread the owner told us to leave alone (2026-10-17).
        sql`not ${legacyQuiet()}`,
        ...(orderId ? [eq(orders.id, orderId)] : []),
        sql`not exists (select 1 from ${assets} s where s.order_id = ${orders.id} and s.type = 'submission'
          and s.deleted_at is null)`,
        sql`not exists (select 1 from ${activityLog} l where l.order_id = ${orders.id}
          and l.actor_id = ${assignments.designerId} and l.created_at >= ${assignments.assignedAt})`,
      ),
    )
    // Oldest wait first: the buyer who has waited longest gets the free hands.
    .orderBy(assignments.assignedAt);
  return rows.map((r) => ({
    orderId: r.orderId,
    orderNumber: r.name ?? r.platformOrderId,
    dueAt: r.dueAt ? new Date(r.dueAt) : null,
    assignmentId: r.assignmentId,
    designerId: r.designerId,
    designerName: r.designerName,
    assignedAt: new Date(r.assignedAt),
    pinnedByAdmin: !!r.pinnedByAdmin,
    style: r.style,
    priorMoves: Number(r.priorMoves),
  }));
}

/**
 * One business. Each order moves in its own transaction (re-checked under a row
 * lock, so a Start pressed while this ran wins); a dry run rolls every
 * transaction back and reports exactly what a real run would do.
 */
export async function runNotStartedPass(
  businessId: string,
  opts: { dryRun?: boolean; now?: Date; maxMoves?: number; outOfTime?: () => boolean } = {},
): Promise<NotStartedReport> {
  const dryRun = !!opts.dryRun;
  const now = opts.now ?? new Date();
  const report = emptyNotStartedReport(dryRun);
  const [biz] = await withSystemContext((tx) =>
    tx.select({ agentConfig: businesses.agentConfig }).from(businesses).where(eq(businesses.id, businessId)).limit(1),
  );
  if (!biz) return report;
  const hours = getAgentConfig(biz).notStartedMoveHours;
  if (hours <= 0) return report;
  const olderThan = new Date(now.getTime() - hours * HOUR);
  let budget = opts.maxMoves ?? 25;

  const waiting = await withSystemContext((tx) => loadNotStarted(tx, businessId, olderThan));
  report.checked = waiting.length;
  for (const w of waiting) {
    if (budget <= 0 || opts.outOfTime?.()) break;
    if (w.pinnedByAdmin) {
      report.keptPinned++;
      continue;
    }
    if (!w.style?.trim()) {
      report.keptNoStyle++;
      continue;
    }
    if (w.priorMoves >= MAX_NOT_STARTED_MOVES) {
      report.keptMovedEnough++;
      continue;
    }
    try {
      let move: NotStartedMove | null = null;
      try {
        // A dry run rolls back: hold its pushes so nobody hears of the move.
        await holdAlphaPushesIf(dryRun, () =>
          withSystemContext(async (tx) => {
            move = await moveOne(tx, businessId, w, now, olderThan);
            if (dryRun) throw new DryRunRollback();
          }),
        );
      } catch (e) {
        if (!(e instanceof DryRunRollback)) throw e;
      }
      if (move) {
        report.moves.push(move);
        budget--;
      } else report.noTarget++;
    } catch (e) {
      report.errors.push({ orderId: w.orderId, message: e instanceof Error ? e.message : String(e) });
    }
  }
  return report;
}

async function moveOne(tx: Tx, businessId: string, w: Waiting, now: Date, olderThan: Date): Promise<NotStartedMove | null> {
  await tx.select({ id: orders.id }).from(orders).where(eq(orders.id, w.orderId)).for("update");
  // Still the same untouched assignment once the order is locked.
  const [still] = await loadNotStarted(tx, businessId, olderThan, w.orderId);
  if (!still || still.assignmentId !== w.assignmentId) return null;

  const model = await loadCapacityModel(tx, businessId, now);
  // Room = not away (quiet hours, deactivated) and under their open-order limit.
  const full = new Set(
    model.designers.filter((d) => d.away || (d.limit > 0 && d.openLoad >= d.limit)).map((d) => d.designerId),
  );
  const ranked = await loadRankedCandidates(tx, { businessId, style: w.style, excludeDesignerId: w.designerId, orderId: w.orderId });
  const target = ranked.find((c) => !full.has(c.designerId));
  if (!target) return null;
  const [t] = await tx.select({ name: users.name }).from(users).where(eq(users.id, target.designerId)).limit(1);

  const hoursWaited = Math.round(((now.getTime() - w.assignedAt.getTime()) / HOUR) * 10) / 10;
  const reason = `It was not started ${Math.floor(hoursWaited)} hours after it was assigned.`;
  const sla = await businessSlaHours(tx, businessId);
  const dueAtHours = handoverDueHours({ orderDueAt: w.dueAt, slaHours: sla.order, urgentHours: sla.urgentRevision }, now);
  // Both designers hear it on the road the 48 h reassignment always used; the
  // brief to the new one goes out from createAssignment straight after.
  await sendDesignerReassigned(tx, { orderId: w.orderId, fromDesignerId: w.designerId, toDesignerId: target.designerId, reason });
  await createAssignment(tx, {
    orderId: w.orderId,
    businessId,
    designerId: target.designerId,
    assignedBy: null,
    dueAtHours,
    reason: "Reassigned from another designer who had not started it.",
  });
  const move: NotStartedMove = {
    orderId: w.orderId,
    orderNumber: w.orderNumber,
    fromDesignerId: w.designerId,
    fromName: w.designerName ?? "Designer",
    toDesignerId: target.designerId,
    toName: t?.name ?? "Designer",
    hoursWaited,
  };
  await tx.insert(activityLog).values({
    businessId,
    orderId: w.orderId,
    actorId: null,
    action: "agent.not_started_moved",
    metadata: {
      from: move.fromDesignerId,
      fromName: move.fromName,
      to: move.toDesignerId,
      toName: move.toName,
      hoursWaited,
      clockHours: Math.round((now.getTime() - olderThan.getTime()) / HOUR),
      move: w.priorMoves + 1,
    },
  });
  return move;
}

