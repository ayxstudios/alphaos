// Agent-owned rebalancing, deactivated designers only (Yousif 2026-10-21:
// orders were vanishing from designer boards). A person's board is never
// emptied for load or quiet hours any more (lib/orders/board-hold.ts): only
// when a designer's login is deactivated are their NOT-YET-STARTED orders moved
// to the best other designer using the assigner's own ranking
// (loadRankedCandidates). Never touches an order with a proof uploaded, in
// revision, or a human-pinned assignment (assignments.assigned_by is a person:
// a human placed it, so a human keeps it).
import { and, desc, eq, sql } from "drizzle-orm";

import { holdAlphaPushesIf } from "@/lib/alpha/client";
import { withSystemContext, type Tx } from "@/lib/db";
import { activityLog, assets, assignments, businesses, orderItems, orders, users } from "@/lib/db/schema";
import { createAssignment, hasReferencePhoto, loadRankedCandidates } from "@/lib/orders/assign";
import { liveOrderWhere } from "@/lib/orders/archive";
import { agentOrderScope, legacyQuiet } from "./scope";

import { loadCapacityModel, type DesignerLoad } from "./capacity";

export type RebalanceMove = {
  orderId: string;
  orderNumber: string;
  businessId: string;
  fromDesignerId: string;
  fromName: string;
  toDesignerId: string;
  toName: string;
  reason: string;
};

export type RebalanceReport = {
  dryRun: boolean;
  moves: RebalanceMove[];
  /** Orders that qualified for a move but sit with a human-pinned assignment. */
  skippedPinned: number;
  /** Orders that qualified for a move but no other designer can take them. */
  noTarget: number;
  errors: { orderId: string; message: string }[];
};

export const emptyRebalanceReport = (dryRun: boolean): RebalanceReport => ({
  dryRun,
  moves: [],
  skippedPinned: 0,
  noTarget: 0,
  errors: [],
});

class DryRunRollback extends Error {}

type Movable = {
  orderId: string;
  orderNumber: string;
  assignedAt: Date;
  assignedBy: string | null;
};

/** Not-yet-started orders a designer holds: assigned but still ready_to_assign, first pass, no proof uploaded. */
async function movableOrders(tx: Tx, businessId: string, designerId: string): Promise<Movable[]> {
  const rows = await tx
    .select({
      orderId: orders.id,
      name: orders.platformOrderName,
      platformOrderId: orders.platformOrderId,
      assignedAt: assignments.assignedAt,
      assignedBy: assignments.assignedBy,
    })
    .from(assignments)
    .innerJoin(orders, eq(orders.id, assignments.orderId))
    .where(
      and(
        eq(assignments.active, true),
        eq(assignments.businessId, businessId),
        eq(assignments.designerId, designerId),
        eq(orders.status, "ready_to_assign"),
        eq(orders.revisionCount, 0),
        liveOrderWhere(),
        agentOrderScope(),
        // Legacy orders its buyer has not reached out on are not shuffled between designers (owner, 2026-10-17).
        sql`not ${legacyQuiet()}`,
        sql`not exists (select 1 from ${assets} where ${assets.orderId} = ${orders.id} and ${assets.type} = 'submission' and ${assets.deletedAt} is null)`,
      ),
    )
    // Newest first: the most recently handed over is the least likely to be started.
    .orderBy(desc(assignments.assignedAt));
  return rows.map((r) => ({
    orderId: r.orderId,
    orderNumber: r.name ?? r.platformOrderId,
    assignedAt: new Date(r.assignedAt),
    assignedBy: r.assignedBy,
  }));
}

async function moveOne(
  tx: Tx,
  input: { businessId: string; order: Movable; from: DesignerLoad; awayIds: Set<string>; reason: string },
): Promise<RebalanceMove | null> {
  const [item] = await tx
    .select({ style: orderItems.style })
    .from(orderItems)
    .where(eq(orderItems.orderId, input.order.orderId))
    .limit(1);
  const ranked = await loadRankedCandidates(tx, {
    businessId: input.businessId,
    style: item?.style ?? null,
    excludeDesignerId: input.from.designerId,
    orderId: input.order.orderId,
  });
  // Same ranking as assignment, minus anyone who is away right now.
  const target = ranked.find((c) => !input.awayIds.has(c.designerId));
  if (!target) return null;
  // Never hand a photo-less order to a new designer (the photo bridge / a card handles it).
  if (!(await hasReferencePhoto(tx, input.order.orderId))) return null;
  const [t] = await tx.select({ name: users.name }).from(users).where(eq(users.id, target.designerId)).limit(1);

  await createAssignment(tx, {
    orderId: input.order.orderId,
    businessId: input.businessId,
    designerId: target.designerId,
    assignedBy: null,
    reason: "Reassigned from another designer.",
  });
  const move: RebalanceMove = {
    orderId: input.order.orderId,
    orderNumber: input.order.orderNumber,
    businessId: input.businessId,
    fromDesignerId: input.from.designerId,
    fromName: input.from.name,
    toDesignerId: target.designerId,
    toName: t?.name ?? "Designer",
    reason: input.reason,
  };
  await tx.insert(activityLog).values({
    businessId: input.businessId,
    orderId: input.order.orderId,
    actorId: null,
    action: "agent.rebalanced",
    metadata: {
      from: move.fromDesignerId,
      fromName: move.fromName,
      to: move.toDesignerId,
      toName: move.toName,
      reason: move.reason,
    },
  });
  return move;
}

/**
 * Plan (and, unless dryRun, apply) moves for one business. Each order moves in
 * its own transaction so one failure never blocks the rest; a dry run rolls
 * every transaction back, so it reports exactly what a real run would do.
 */
export async function rebalanceBusiness(
  businessId: string,
  opts: { dryRun?: boolean; now?: Date; maxMoves?: number } = {},
): Promise<RebalanceReport> {
  const dryRun = !!opts.dryRun;
  const now = opts.now ?? new Date();
  const report = emptyRebalanceReport(dryRun);
  let budget = opts.maxMoves ?? 25;

  const model = await withSystemContext((tx) => loadCapacityModel(tx, businessId, now));
  const awayIds = new Set(model.designers.filter((d) => d.away).map((d) => d.designerId));
  // Donors: deactivated designers only; a person still on the team keeps their board.
  const donors = model.designers.filter((d) => !d.active && d.queued > 0);

  for (const from of donors) {
    const candidates = await withSystemContext((tx) => movableOrders(tx, businessId, from.designerId));
    for (const order of candidates) {
      if (budget <= 0) return report;
      const reason = `${from.name} is deactivated`;

      if (order.assignedBy) {
        report.skippedPinned += 1;
        continue;
      }

      try {
        let move: RebalanceMove | null = null;
        try {
          // A dry run (the capacity page preview) rolls back: hold its pushes.
          await holdAlphaPushesIf(dryRun, () =>
            withSystemContext(async (tx) => {
              move = await moveOne(tx, { businessId, order, from, awayIds, reason });
              if (dryRun) throw new DryRunRollback();
            }),
          );
        } catch (e) {
          if (!(e instanceof DryRunRollback)) throw e;
        }
        if (move) {
          report.moves.push(move);
          budget -= 1;
        } else report.noTarget += 1;
      } catch (e) {
        report.errors.push({ orderId: order.orderId, message: e instanceof Error ? e.message : String(e) });
      }
    }
  }
  return report;
}

/** The runAgentTick hook: only when the business has the agent's assign switch on. */
export async function runRebalance(
  businessId: string,
  opts: { dryRun?: boolean; now?: Date; force?: boolean } = {},
): Promise<RebalanceReport> {
  if (!opts.force) {
    const [biz] = await withSystemContext((tx) =>
      tx.select({ on: businesses.agentAssignEnabled }).from(businesses).where(eq(businesses.id, businessId)).limit(1),
    );
    if (!biz?.on) return emptyRebalanceReport(!!opts.dryRun);
  }
  return rebalanceBusiness(businessId, opts);
}

/** For the capacity screen: what a run would do right now, without changing anything. */
export function previewRebalance(businessId: string): Promise<RebalanceReport> {
  return rebalanceBusiness(businessId, { dryRun: true });
}
