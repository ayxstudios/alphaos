import { sql, type SQL } from "drizzle-orm";

import { orders } from "@/lib/db/schema";

/**
 * The WORK CLOCK: the deadline of the piece of work in hand, not the order's
 * birthday. Yousif 2026-11-06: "the revision sort of resets the timer. An order
 * that took 3 days and is 2 days into a revision should say revision, 2 days
 * old, not 5 days late."
 *
 * While an order is being drawn or waits for QC, that clock is the active
 * assignment's due_at, which lib/orders/assign.ts resetRevisionDeadline sets
 * afresh on every customer revision and QC fail (revisionSlaHours /
 * qcFailSlaHours). Everywhere else (waiting on photos, with the customer, at
 * print) the customer's own date, orders.due_at, is the clock. A legacy
 * assignment with no due_at falls back to the customer date too.
 *
 * orders.due_at itself never moves: it stays the customer-facing promise, shown
 * as "Customer due" next to the work clock where both matter.
 */
export const WORK_CLOCK_STATUSES = ["in_design", "awaiting_qc"] as const;

export function workDueAt(input: {
  status: string;
  dueAt: Date | null;
  assignmentDueAt: Date | null;
}): Date | null {
  if ((WORK_CLOCK_STATUSES as readonly string[]).includes(input.status)) return input.assignmentDueAt ?? input.dueAt;
  return input.dueAt;
}

/**
 * The same rule in SQL, as a scalar over `orders` (no join needed), so a count
 * of overdue orders and the Orders page "Overdue" view agree with the boards.
 */
export function workDueAtSql(): SQL<Date | null> {
  return sql<Date | null>`case
    when ${orders.status} in ('in_design', 'awaiting_qc') then coalesce(
      (select a.due_at from assignments a where a.order_id = ${orders.id} and a.active order by a.created_at desc limit 1),
      ${orders.dueAt})
    else ${orders.dueAt}
  end`;
}

/** "2d old", "5h old", "just now": how long a revision or QC fail has been on the board. */
export function ageLabel(sinceIso: string, now = Date.now()): string {
  const h = Math.floor((now - new Date(sinceIso).getTime()) / 3_600_000);
  if (h < 1) return "just now";
  if (h < 24) return `${h}h old`;
  return `${Math.floor(h / 24)}d old`;
}
