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
  qcChecks,
  activityLog,
  users,
  shops,
  orderStatus,
} from "@/lib/db/schema";
import {
  resolveChecklist,
  type ChecklistSnapshot,
  type ItemResults,
} from "@/lib/qc/checklist";
import { runAutoAssign } from "./assign";
import { prepareProofForApproval } from "@/lib/email/dispatch";
import { createEarningForCompletion } from "@/lib/orders/earnings";

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
  "ready_to_assign->awaiting_qc": { roles: STAFF_AND_DESIGNER }, // recover cards already completed off-board
  "in_design->ready_to_assign": { roles: STAFF_AND_DESIGNER }, // move back if started by mistake
  "in_design->awaiting_qc": { roles: STAFF_AND_DESIGNER }, // designer submits
  "awaiting_qc->ready_to_assign": { roles: STAFF_AND_DESIGNER }, // move back if submitted to QC by mistake
  "awaiting_qc->awaiting_approval": { roles: STAFF }, // QC pass
  "awaiting_qc->in_design": { roles: STAFF_AND_DESIGNER, revision: true }, // QC fail / designer pullback
  "awaiting_approval->approved": { roles: STAFF }, // customer/VA approves
  "awaiting_approval->in_design": { roles: STAFF, revision: true }, // customer revision
  "approved->in_design": { roles: STAFF, revision: true }, // late customer revision
  "printing->in_design": { roles: STAFF, revision: true }, // late customer revision
  "shipped->in_design": { roles: STAFF, revision: true }, // late customer revision
  "delivered->in_design": { roles: STAFF, revision: true }, // late customer revision
  "complete->in_design": { roles: STAFF, revision: true }, // late customer revision
  "approved->printing": { roles: STAFF }, // physical
  "approved->complete": { roles: STAFF }, // digital shortcut
  "printing->shipped": { roles: STAFF },
  "shipped->delivered": { roles: STAFF },
  "delivered->complete": { roles: STAFF },
  // Triage (VA classifies a draft order — one click either way). Portrait routes
  // rejoin the normal flow; the non-portrait routes never touch design.
  "triage->awaiting_photos": { roles: STAFF }, // portrait, still needs photos
  "triage->ready_to_assign": { roles: STAFF }, // portrait, photos already attached
  "triage->fulfillment_only": { roles: STAFF }, // not portrait, needs fulfilment
  "triage->complete": { roles: STAFF }, // not portrait, nothing to fulfil (billing)
  // Fulfilment-only add-ons: fulfil or close. NO edge to in_design/awaiting_qc/
  // awaiting_approval exists, so these can never reach a designer or a proof.
  "fulfillment_only->printing": { roles: STAFF },
  "fulfillment_only->complete": { roles: STAFF },
  // Etsy imports land here; a VA completes the details (manual form) and it
  // enters the normal pipeline.
  "awaiting_details->ready_to_assign": { roles: STAFF }, // details + photos entered
  "awaiting_details->awaiting_photos": { roles: STAFF }, // details entered, no photos yet
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
    "triage", "fulfillment_only", "awaiting_details",
  ];
  return Object.fromEntries(from.map((s) => [`${s}->on_hold`, { roles: STAFF }]));
}
function resumeEdges(): Record<string, Edge> {
  const to: OrderStatus[] = [
    "ready_to_assign", "in_design", "awaiting_qc", "awaiting_approval",
    "approved", "printing", "shipped",
    "triage", "fulfillment_only", "awaiting_details",
  ];
  return Object.fromEntries(to.map((s) => [`on_hold->${s}`, { roles: STAFF }]));
}
function cancelEdges(): Record<string, Edge> {
  const from: OrderStatus[] = [
    "awaiting_photos", "ready_to_assign", "in_design", "awaiting_qc",
    "awaiting_approval", "approved", "printing", "shipped", "delivered", "on_hold",
    "triage", "fulfillment_only", "awaiting_details",
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

/**
 * The core transition, run inside a caller-provided transaction. Exported so a
 * flow that must do extra work atomically with the status change (e.g. the proof
 * portal claiming its read-only decision lock in the same tx) can compose it,
 * rather than opening a second transaction. Request/system callers should use
 * `transition` / `transitionAsSystem`, which open the correctly-scoped tx.
 */
export async function runTransition(tx: Tx, actor: Actor, input: TransitionInput): Promise<{ status: OrderStatus }> {
  const { orderId, to, expectedFrom } = input;

  // Lock the row; RLS also scopes visibility (designers only see their own).
  const [order] = await tx
    .select({
      id: orders.id,
      businessId: orders.businessId,
      shopId: orders.shopId,
      customerId: orders.customerId,
      status: orders.status,
      revisionCount: orders.revisionCount,
      platformOrderId: orders.platformOrderId,
      platformOrderName: orders.platformOrderName,
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

  // A completion that comes from a non-portrait lifecycle is NOT design work:
  // figure count is irrelevant and no designer is paid. Gated on the from-state
  // so it's driven by the state machine, not a flag.
  const nonPortraitComplete =
    to === "complete" && (order.status === "triage" || order.status === "fulfillment_only");

  // Preconditions before we mutate anything.
  if (to === "complete" && !nonPortraitComplete) {
    await assertFiguresResolved(tx, orderId, order.platformOrderId);
  }

  // QC gate — enforced HERE, not just in the UI/action, so a crafted request
  // can't pass QC without every item ticked. The checklist is resolved from the
  // order's shop (never trusted from the client); the client only supplies the
  // per-item verdicts. This also produces the authoritative snapshot we persist.
  let qc: QcOutcome | null = null;
  if (key === "awaiting_qc->awaiting_approval") qc = await assertQc(tx, order, "pass", input.metadata);
  if (key === "awaiting_qc->in_design") qc = await assertQc(tx, order, "fail", input.metadata);

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
  if (qc) await insertQc(tx, order, actor, qc);
  // Earnings only for design completions. Non-portrait completes never pay
  // (and have no assignment anyway — createEarnings is a double safeguard).
  if (to === "complete" && !nonPortraitComplete) await createEarningForCompletion(tx, order.id, order.businessId);

  // Email side effects, composed into this transaction so a rolled-back
  // transition never leaves a stray proof or draft. See lib/email/dispatch.ts.
  if (to === "awaiting_approval") {
    // Create the proof + token and draft the "proof ready" email for VA approval.
    await prepareProofForApproval(tx, {
      id: order.id,
      businessId: order.businessId,
      customerId: order.customerId,
      platformOrderId: order.platformOrderId,
      platformOrderName: order.platformOrderName,
    });
  }
  // Customer revision email is sent after the revised portrait passes QC, not
  // when the customer first requests changes.

  // The full checklist snapshot + per-item results live on the qc_checks row
  // (the audit source of truth); keep the heavy blobs out of activity_log, but
  // preserve the compact fields (reason, failed items) that make the log useful.
  const logMeta: Record<string, unknown> = { edge: key };
  for (const [k, v] of Object.entries(input.metadata ?? {})) {
    if (k !== "checklistSnapshot" && k !== "itemResults" && k !== "reason" && k !== "failedItems") {
      logMeta[k] = v;
    }
  }
  // For QC edges, log the server-authoritative reason + failed items (never the
  // client's), so the activity trail matches what was actually enforced.
  if (qc) {
    if (qc.reason) logMeta.reason = qc.reason;
    logMeta.failedItems = qc.checklist.items
      .filter((it) => qc!.itemResults[it.key] === false)
      .map((it) => it.label);
    logMeta.checklistVersion = qc.checklist.version;
  }
  await tx.insert(activityLog).values({
    businessId: order.businessId,
    orderId,
    actorId: actor.role === "system" ? null : actor.id,
    action: `order.${to}`,
    fromState: order.status,
    toState: to,
    metadata: logMeta,
  });

  return { status: to };
}

/* --- side effects ------------------------------------------------------- */
async function assertFiguresResolved(tx: Tx, orderId: string, platformOrderId: string): Promise<void> {
  const items = await tx
    .select({ figureCount: orderItems.figureCount })
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId));
  if (items.length === 0) {
    throw new PreconditionError(
      `Cannot complete order ${platformOrderId}: it has no order items. Add the purchased item first (items drive payout).`,
    );
  }
  if (items.some((i) => i.figureCount == null)) {
    throw new PreconditionError(
      `Cannot complete order ${platformOrderId}: it has an unresolved figure count. Resolve it from Orders first (figure count drives payout).`,
    );
  }
}

type QcOutcome = {
  result: "pass" | "fail";
  checklist: ChecklistSnapshot;
  itemResults: ItemResults;
  reason: string | null;
};

/**
 * The QC gate. Resolves the authoritative checklist from the order's SHOP (never
 * trusting a client-supplied list), coerces the caller's per-item verdicts
 * against it, and enforces the pass/fail invariants:
 *   pass -> every checklist item must be ticked
 *   fail -> at least one item failed AND a non-empty reason
 * Returns the server-authoritative outcome to persist. Throws PreconditionError
 * otherwise, so the transaction rolls back and status never advances.
 */
async function assertQc(
  tx: Tx,
  order: { shopId: string },
  result: "pass" | "fail",
  metadata?: Record<string, unknown>,
): Promise<QcOutcome> {
  const [shop] = await tx
    .select({ checklistVersion: shops.checklistVersion, integrationConfig: shops.integrationConfig })
    .from(shops)
    .where(eq(shops.id, order.shopId));
  const checklist = resolveChecklist({
    checklistVersion: shop?.checklistVersion ?? 1,
    integrationConfig: shop?.integrationConfig ?? null,
  });

  const raw = (metadata?.itemResults ?? {}) as Record<string | number, unknown>;
  // Normalise to the authoritative items only; anything not strictly true fails.
  const itemResults: ItemResults = {};
  for (const it of checklist.items) itemResults[it.key] = raw[it.key] === true;

  if (result === "pass") {
    const allTicked =
      checklist.items.length > 0 && checklist.items.every((it) => itemResults[it.key]);
    if (!allTicked) {
      throw new PreconditionError(
        "Cannot pass QC: every checklist item must be ticked.",
      );
    }
    return { result, checklist, itemResults, reason: null };
  }

  // Fail.
  const anyFailed = checklist.items.some((it) => !itemResults[it.key]);
  const reason = typeof metadata?.reason === "string" ? metadata.reason.trim() : "";
  if (!anyFailed) {
    throw new PreconditionError("Cannot fail QC: mark at least one checklist item as failed.");
  }
  if (!reason) {
    throw new PreconditionError("Cannot fail QC: a reason for the designer is required.");
  }
  return { result, checklist, itemResults, reason };
}

async function insertQc(
  tx: Tx,
  order: { id: string; businessId: string },
  actor: Actor,
  qc: QcOutcome,
): Promise<void> {
  await tx.insert(qcChecks).values({
    businessId: order.businessId,
    orderId: order.id,
    vaId: actor.role === "system" ? null : actor.id,
    result: qc.result,
    reason: qc.reason,
    // Exact checklist used (versioned) + the per-item verdicts, snapshotted so a
    // later audit shows which standard applied at the time.
    checklistSnapshot: qc.checklist,
    itemResults: qc.itemResults,
  });
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
