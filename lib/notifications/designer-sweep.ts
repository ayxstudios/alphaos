/**
 * Designer lane of the SLA sweep: nudge a designer 24 h after assignment with
 * no submission uploaded, and reassign at 48 h to the next eligible designer.
 *
 * Behind `ALPHA_ACTIONS_ENABLED` (default off): candidates are always computed
 * and logged so ops can size the effect before flipping it on; only when the
 * flag is true (and the caller isn't previewing) do we actually write the
 * notification_fires row, send Alpha events, or touch assignments. Idempotent
 * per assignment via notification_fires (one row = one fire), so re-running
 * the sweep every 15 minutes never double-nudges or double-reassigns.
 *
 * "Never reassign an order that has a submission awaiting QC": the candidate
 * query is scoped to orders still in_design (an order with a submission
 * already sent for QC is in awaiting_qc and never appears here), and a
 * submission uploaded after the CURRENT assignment started disqualifies the
 * order from both nudge and reassign — a stale submission from a previous
 * designer (before reassignment) does not count.
 */
import { and, eq, inArray, lte } from "drizzle-orm";

import type { Tx } from "@/lib/db";
import { liveOrderWhere } from "@/lib/orders/archive";
import { findNextEligibleDesigner, createAssignment } from "@/lib/orders/assign";
import {
  sendDesignerNudge,
  sendDesignerReassigned,
  sendVaAttention,
} from "@/lib/notifications/designer-events";
import { assets, assignments, activityLog, notificationFires, orderItems, orders } from "@/lib/db/schema";
import { ALERT_TYPES } from "./types";

const HOUR = 60 * 60 * 1000;
const NUDGE_AFTER_MS = 24 * HOUR;
const REASSIGN_AFTER_MS = 48 * HOUR;

export type DesignerLaneResult = {
  enabled: boolean;
  nudgeCandidates: number;
  nudgeFired: number;
  reassignCandidates: number;
  reassigned: number;
  reassignBlockedNoEligible: number;
  skippedDuplicate: number;
};

type AssignmentRow = {
  assignmentId: string;
  orderId: string;
  businessId: string;
  designerId: string;
  assignedAt: Date;
  dueAt: Date | null;
  orderNumber: string | null;
  fallbackNumber: string;
};

async function loadInDesignAssignments(tx: Tx, now: Date): Promise<AssignmentRow[]> {
  return tx
    .select({
      assignmentId: assignments.id,
      orderId: assignments.orderId,
      businessId: assignments.businessId,
      designerId: assignments.designerId,
      assignedAt: assignments.assignedAt,
      dueAt: assignments.dueAt,
      orderNumber: orders.platformOrderName,
      fallbackNumber: orders.platformOrderId,
    })
    .from(assignments)
    .innerJoin(orders, eq(orders.id, assignments.orderId))
    .where(
      and(
        eq(assignments.active, true),
        eq(orders.status, "in_design"),
        lte(assignments.assignedAt, new Date(now.getTime() - NUDGE_AFTER_MS)),
        liveOrderWhere(),
      ),
    );
}

/** Order ids (among the given assignments) that already have a submission uploaded since their assignment started. */
async function orderIdsWithSubmissionSince(tx: Tx, rows: AssignmentRow[]): Promise<Set<string>> {
  if (!rows.length) return new Set();
  const orderIds = rows.map((r) => r.orderId);
  const subs = await tx
    .select({ orderId: assets.orderId, createdAt: assets.createdAt })
    .from(assets)
    .where(and(inArray(assets.orderId, orderIds), eq(assets.type, "submission")));
  const earliestByOrder = new Map<string, Date>();
  for (const r of rows) earliestByOrder.set(r.orderId, r.assignedAt);
  const has = new Set<string>();
  for (const s of subs) {
    const since = earliestByOrder.get(s.orderId);
    if (since && s.createdAt >= since) has.add(s.orderId);
  }
  return has;
}

/** Claim a fire (insert-if-absent). Returns true iff this call won the race. */
async function claimFire(
  tx: Tx,
  input: { businessId: string; alertType: string; subjectId: string; metadata?: Record<string, unknown> },
): Promise<boolean> {
  const dedupeKey = `${input.alertType}:${input.subjectId}`;
  const [row] = await tx
    .insert(notificationFires)
    .values({
      businessId: input.businessId,
      alertType: input.alertType,
      subjectType: "assignment",
      subjectId: input.subjectId,
      dedupeKey,
      metadata: input.metadata ?? null,
    })
    .onConflictDoNothing({ target: notificationFires.dedupeKey })
    .returning({ id: notificationFires.id });
  return !!row;
}

export async function runDesignerLaneSweep(
  tx: Tx,
  now: Date,
  opts: { enabled: boolean },
): Promise<DesignerLaneResult> {
  const result: DesignerLaneResult = {
    enabled: opts.enabled,
    nudgeCandidates: 0,
    nudgeFired: 0,
    reassignCandidates: 0,
    reassigned: 0,
    reassignBlockedNoEligible: 0,
    skippedDuplicate: 0,
  };

  const rows = await loadInDesignAssignments(tx, now);
  if (!rows.length) return result;

  const withSubmission = await orderIdsWithSubmissionSince(tx, rows);
  const nudgeRows = rows.filter((r) => !withSubmission.has(r.orderId));
  result.nudgeCandidates = nudgeRows.length;

  const reassignRows = nudgeRows.filter(
    (r) => now.getTime() - r.assignedAt.getTime() >= REASSIGN_AFTER_MS,
  );
  result.reassignCandidates = reassignRows.length;
  const reassignIds = new Set(reassignRows.map((r) => r.assignmentId));

  // Candidates for a nudge only (not yet at the 48 h reassign threshold).
  const nudgeOnlyRows = nudgeRows.filter((r) => !reassignIds.has(r.assignmentId));

  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      component: "notifications",
      event: "designer_lane_sweep",
      enabled: opts.enabled,
      nudgeCandidates: result.nudgeCandidates,
      reassignCandidates: result.reassignCandidates,
    }),
  );

  if (!opts.enabled) return result;

  for (const row of nudgeOnlyRows) {
    const claimed = await claimFire(tx, {
      businessId: row.businessId,
      alertType: ALERT_TYPES.designerNudge24h,
      subjectId: row.assignmentId,
    });
    if (!claimed) {
      result.skippedDuplicate++;
      continue;
    }
    await sendDesignerNudge(tx, {
      orderId: row.orderId,
      designerId: row.designerId,
      dueAt: row.dueAt,
      hoursSinceAssigned: (now.getTime() - row.assignedAt.getTime()) / HOUR,
      now,
    });
    result.nudgeFired++;
  }

  for (const row of reassignRows) {
    // Safety re-check right before mutating: the order may have moved out of
    // in_design (e.g. the designer submitted moments ago) or picked up a
    // submission since the candidate query ran. Never reassign an order with
    // a submission awaiting QC.
    const [fresh] = await tx
      .select({ status: orders.status })
      .from(orders)
      .where(eq(orders.id, row.orderId))
      .limit(1);
    if (!fresh || fresh.status !== "in_design") {
      result.skippedDuplicate++;
      continue;
    }
    const [freshAssignment] = await tx
      .select({ id: assignments.id, designerId: assignments.designerId })
      .from(assignments)
      .where(and(eq(assignments.orderId, row.orderId), eq(assignments.active, true)))
      .limit(1);
    if (!freshAssignment || freshAssignment.id !== row.assignmentId) {
      result.skippedDuplicate++;
      continue;
    }
    const [item] = await tx
      .select({ style: orderItems.style })
      .from(orderItems)
      .where(eq(orderItems.orderId, row.orderId))
      .limit(1);

    const nextDesignerId = await findNextEligibleDesigner(tx, {
      businessId: row.businessId,
      style: item?.style ?? null,
      excludeDesignerId: row.designerId,
    });

    if (!nextDesignerId) {
      const claimed = await claimFire(tx, {
        businessId: row.businessId,
        alertType: ALERT_TYPES.designerReassignBlocked,
        subjectId: row.assignmentId,
      });
      if (claimed) {
        await sendVaAttention(tx, {
          businessId: row.businessId,
          orderId: row.orderId,
          text:
            `Order ${row.orderNumber ?? row.fallbackNumber} has had no portrait uploaded for 48 hours ` +
            `and no other eligible designer was found to move it to. Please reassign it by hand.`,
          payload: { assignmentId: row.assignmentId, currentDesignerId: row.designerId },
        });
        result.reassignBlockedNoEligible++;
      } else {
        result.skippedDuplicate++;
      }
      continue;
    }

    const claimed = await claimFire(tx, {
      businessId: row.businessId,
      alertType: ALERT_TYPES.designerReassigned48h,
      subjectId: row.assignmentId,
      metadata: { fromDesignerId: row.designerId, toDesignerId: nextDesignerId },
    });
    if (!claimed) {
      result.skippedDuplicate++;
      continue;
    }

    const reason = "No portrait was uploaded within 48 hours of assignment.";
    await tx.insert(activityLog).values({
      businessId: row.businessId,
      orderId: row.orderId,
      actorId: null,
      action: "order.reassigned",
      metadata: {
        via: "sla_sweep_48h",
        reason,
        fromDesignerId: row.designerId,
        toDesignerId: nextDesignerId,
      },
    });

    // createAssignment deactivates the old row, inserts the new one, and
    // sends the new designer their full designer.brief.
    await createAssignment(tx, {
      orderId: row.orderId,
      businessId: row.businessId,
      designerId: nextDesignerId,
      assignedBy: null,
      reason: "Reassigned automatically after 48 hours with no submission.",
    });
    await sendDesignerReassigned(tx, {
      orderId: row.orderId,
      fromDesignerId: row.designerId,
      toDesignerId: nextDesignerId,
      reason,
    });
    await sendVaAttention(tx, {
      businessId: row.businessId,
      orderId: row.orderId,
      text: `Order ${row.orderNumber ?? row.fallbackNumber} was automatically reassigned after 48 hours with no submission.`,
      payload: { assignmentId: row.assignmentId, fromDesignerId: row.designerId, toDesignerId: nextDesignerId },
    });
    result.reassigned++;
  }

  return result;
}
