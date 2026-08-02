import { and, desc, eq } from "drizzle-orm";

import {
  withUserContext,
  withSystemContext,
  SYSTEM_ACTOR_ID,
  type RequestUser,
  type Tx,
} from "@/lib/db";
import {
  orders,
  orderItems,
  assignments,
  earnings,
  qcChecks,
  designerProfiles,
  activityLog,
  users,
  orderStatus,
} from "@/lib/db/schema";
import { runAutoAssign } from "./assign";

export type OrderStatus = (typeof orderStatus.enumValues)[number];
export type TransitionRole = "admin" | "va" | "designer" | "system";
type Actor = { id: string; role: TransitionRole };

const STAFF: TransitionRole[] = ["admin", "va", "system"];
const STAFF_AND_DESIGNER: TransitionRole[] = ["admin", "va", "system", "designer"];

type Edge = { roles: TransitionRole[]; revision?: boolean };

/**
 * The ONLY legal order-status transitions and who may make them. Anything not
 * listed is illegal. Designers appear on exactly the two pre-QC edges below
 * (start + submit) on their own assigned orders; they can never reach
 * awaiting_approval / approved / complete by any path — QC is the gate.
 */
const GRAPH: Record<string, Edge> = {
  "awaiting_photos->ready_to_assign": { roles: STAFF },
  "ready_to_assign->in_design": { roles: STAFF_AND_DESIGNER }, // designer starts
  "in_design->awaiting_qc": { roles: STAFF_AND_DESIGNER }, // designer submits
  "awaiting_qc->awaiting_approval": { roles: STAFF }, // QC pass
  "awaiting_qc->in_design": { roles: STAFF, revision: true }, // QC fail
  "awaiting_approval->approved": { roles: STAFF }, // customer/VA approves
  "awaiting_approval->in_design": { roles: STAFF, revision: true }, // customer revision
  "approved->printing": { roles: STAFF }, // physical
  "approved->complete": { roles: STAFF }, // digital shortcut
  "printing->shipped": { roles: STAFF },
  "shipped->delivered": { roles: STAFF },
  "delivered->complete": { roles: STAFF },
  // Hold from any active state.
  ...holdEdges(),
  // Resume from hold to any active working state.
  ...resumeEdges(),
  // Cancel from any non-terminal state.
  ...cancelEdges(),
};

function holdEdges(): Record<string, Edge> {
  const from: OrderStatus[] = [
    "awaiting_photos", "ready_to_assign", "in_design", "awaiting_qc",
    "awaiting_approval", "approved", "printing", "shipped",
  ];
  return Object.fromEntries(from.map((s) => [`${s}->on_hold`, { roles: STAFF }]));
}
function resumeEdges(): Record<string, Edge> {
  const to: OrderStatus[] = [
    "ready_to_assign", "in_design", "awaiting_qc", "awaiting_approval",
    "approved", "printing", "shipped",
  ];
  return Object.fromEntries(to.map((s) => [`on_hold->${s}`, { roles: STAFF }]));
}
function cancelEdges(): Record<string, Edge> {
  const from: OrderStatus[] = [
    "awaiting_photos", "ready_to_assign", "in_design", "awaiting_qc",
    "awaiting_approval", "approved", "printing", "shipped", "delivered", "on_hold",
  ];
  return Object.fromEntries(from.map((s) => [`${s}->cancelled`, { roles: STAFF }]));
}

/* --- typed errors ------------------------------------------------------- */
export class OrderTransitionError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "OrderTransitionError";
  }
}
export class OrderNotFoundError extends OrderTransitionError {
  constructor(orderId: string) {
    super("not_found", `Order ${orderId} not found or not visible in this context`);
  }
}
export class IllegalTransitionError extends OrderTransitionError {
  constructor(from: string, to: string) {
    super("illegal", `Illegal transition ${from} -> ${to}`);
  }
}
export class ForbiddenTransitionError extends OrderTransitionError {
  constructor(role: string, from: string, to: string) {
    super("forbidden", `Role "${role}" may not transition ${from} -> ${to}`);
  }
}
export class StaleTransitionError extends OrderTransitionError {
  movedBy: string;
  actual: string;
  constructor(expected: string, actual: string, movedBy: string) {
    super("stale", `This order was already moved by ${movedBy} (expected ${expected}, was ${actual})`);
    this.movedBy = movedBy;
    this.actual = actual;
  }
}
export class PreconditionError extends OrderTransitionError {
  constructor(message: string) {
    super("precondition", message);
  }
}

export type TransitionInput = {
  orderId: string;
  to: OrderStatus;
  expectedFrom: OrderStatus; // the status the client believed the order was in
  metadata?: Record<string, unknown>;
};

/** Legal staff transitions out of a status — used to render VA queue actions. */
export function staffTransitionsFrom(status: OrderStatus): OrderStatus[] {
  return Object.entries(GRAPH)
    .filter(([key, edge]) => key.startsWith(`${status}->`) && edge.roles.includes("va"))
    .map(([key]) => key.split("->")[1] as OrderStatus);
}

/** Transition triggered by a signed-in user (board server actions). */
export function transition(actor: RequestUser, input: TransitionInput): Promise<{ status: OrderStatus }> {
  return withUserContext(actor, (tx) => runTransition(tx, actor, input));
}

/** Transition triggered by no user (proof link, webhooks, importers, cron). */
export function transitionAsSystem(input: TransitionInput): Promise<{ status: OrderStatus }> {
  return withSystemContext((tx) => runTransition(tx, { id: SYSTEM_ACTOR_ID, role: "system" }, input));
}

async function runTransition(tx: Tx, actor: Actor, input: TransitionInput): Promise<{ status: OrderStatus }> {
  const { orderId, to, expectedFrom } = input;

  // Lock the row; RLS also scopes visibility (designers only see their own).
  const [order] = await tx
    .select({
      id: orders.id,
      businessId: orders.businessId,
      status: orders.status,
      revisionCount: orders.revisionCount,
      platformOrderId: orders.platformOrderId,
    })
    .from(orders)
    .where(eq(orders.id, orderId))
    .for("update");

  if (!order) throw new OrderNotFoundError(orderId);

  // Optimistic concurrency: the client's belief must match reality.
  if (order.status !== expectedFrom) {
    throw new StaleTransitionError(expectedFrom, order.status, await lastActorName(tx, orderId));
  }

  const key = `${order.status}->${to}`;
  const edge = GRAPH[key];
  if (!edge) throw new IllegalTransitionError(order.status, to);
  if (!edge.roles.includes(actor.role)) {
    throw new ForbiddenTransitionError(actor.role, order.status, to);
  }

  // Preconditions before we mutate anything.
  if (to === "complete") await assertFiguresResolved(tx, orderId, order.platformOrderId);

  // Conditional (compare-and-swap) update — belt to the FOR UPDATE braces.
  const updated = await tx
    .update(orders)
    .set({
      status: to,
      updatedAt: new Date(),
      ...(edge.revision ? { revisionCount: order.revisionCount + 1 } : {}),
    })
    .where(and(eq(orders.id, orderId), eq(orders.status, expectedFrom)))
    .returning({ id: orders.id });
  if (!updated.length) {
    throw new StaleTransitionError(expectedFrom, "(changed)", await lastActorName(tx, orderId));
  }

  // Side effects (all inside this transaction).
  if (to === "ready_to_assign") {
    await runAutoAssign(tx, { orderId, businessId: order.businessId, assignedBy: actor.role === "system" ? null : actor.id });
  }
  if (key === "awaiting_qc->awaiting_approval") await insertQc(tx, order, actor, "pass", input.metadata);
  if (key === "awaiting_qc->in_design") await insertQc(tx, order, actor, "fail", input.metadata);
  if (to === "complete") await createEarnings(tx, order.id, order.businessId);

  await tx.insert(activityLog).values({
    businessId: order.businessId,
    orderId,
    actorId: actor.role === "system" ? null : actor.id,
    action: `order.${to}`,
    fromState: order.status,
    toState: to,
    metadata: { edge: key, ...(input.metadata ?? {}) },
  });

  return { status: to };
}

/* --- side effects ------------------------------------------------------- */
async function assertFiguresResolved(tx: Tx, orderId: string, platformOrderId: string): Promise<void> {
  const items = await tx
    .select({ figureCount: orderItems.figureCount })
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId));
  if (items.some((i) => i.figureCount == null)) {
    throw new PreconditionError(
      `Cannot complete order ${platformOrderId}: it has an unresolved figure count. Resolve it at /queue/review first (figure count drives payout).`,
    );
  }
}

async function insertQc(
  tx: Tx,
  order: { id: string; businessId: string },
  actor: Actor,
  result: "pass" | "fail",
  metadata?: Record<string, unknown>,
): Promise<void> {
  await tx.insert(qcChecks).values({
    businessId: order.businessId,
    orderId: order.id,
    vaId: actor.role === "system" ? null : actor.id,
    result,
    reason: typeof metadata?.reason === "string" ? metadata.reason : null,
  });
}

async function createEarnings(tx: Tx, orderId: string, businessId: string): Promise<void> {
  const [assignment] = await tx
    .select({ designerId: assignments.designerId })
    .from(assignments)
    .where(and(eq(assignments.orderId, orderId), eq(assignments.active, true)));
  if (!assignment) return; // no active assignee — nothing to pay

  const items = await tx
    .select({ figureCount: orderItems.figureCount })
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId));
  const totalFigures = items.reduce((sum, i) => sum + (i.figureCount ?? 0), 0);

  const [profile] = await tx
    .select({ rate: designerProfiles.perFigureRate })
    .from(designerProfiles)
    .where(eq(designerProfiles.userId, assignment.designerId));
  const rate = profile?.rate ?? "0";
  const amount = (totalFigures * Number(rate)).toFixed(2);
  const period = new Date().toISOString().slice(0, 7); // YYYY-MM

  // One earning per order, ever (protects against double-pay on any re-entry).
  await tx
    .insert(earnings)
    .values({
      businessId,
      designerId: assignment.designerId,
      orderId,
      figureCount: totalFigures,
      rate: String(rate),
      amount,
      period,
      status: "pending",
    })
    .onConflictDoNothing({ target: earnings.orderId });
}

async function lastActorName(tx: Tx, orderId: string): Promise<string> {
  const [row] = await tx
    .select({ name: users.name, actorId: activityLog.actorId })
    .from(activityLog)
    .leftJoin(users, eq(users.id, activityLog.actorId))
    .where(eq(activityLog.orderId, orderId))
    .orderBy(desc(activityLog.createdAt))
    .limit(1);
  if (!row) return "someone";
  return row.name ?? (row.actorId ? "another user" : "the system");
}
