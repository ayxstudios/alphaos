/**
 * Designer-bound Alpha events, in plain English. Every message a designer gets
 * from Alpha about an order is composed here so the wording, the links and the
 * privacy rule (first name only, never an email) live in one place.
 *
 *   sendDesignerBrief      new assignment (auto or manual)
 *   sendDesignerNudge      24 h with no portrait uploaded
 *   sendDesignerReassigned 48 h: the order moved to someone else (both told)
 *   sendQcFeedback         QC failed: the failed items + a link
 *   sendVaAttention        something a VA must look at now
 *
 * Quiet hours: a brief / nudge / QC feedback that would land inside the
 * designer's quiet window carries payload.deliverAfter = window end (the daemon
 * honours it). Escalations (reassigned, va.attention) never wait.
 */
import { and, desc, eq } from "drizzle-orm";

import type { Tx } from "@/lib/db";
import { sendAlphaEvent } from "@/lib/alpha/client";
import { assignments, customerPublic, orderItems, orders, proofs, qcChecks } from "@/lib/db/schema";
import { loadDesignerContact, type DesignerContact } from "@/lib/designers/profile";
import { formatInTimezone, quietWindowEnd } from "@/lib/designers/quiet-hours";
import type { ChecklistSnapshot, ItemResults } from "@/lib/qc/checklist";
import { appUrl } from "@/lib/urls";

type OrderBrief = {
  id: string;
  businessId: string;
  number: string;
  customerFirstName: string | null;
  style: string | null;
  figureCount: number | null;
  title: string | null;
  options: { name: string; value: string }[];
  notes: string | null;
};

export function orderLinks(orderId: string) {
  return { orderUrl: appUrl(`/orders/${orderId}`), boardUrl: appUrl("/board") };
}

/** Everything a designer may know about an order: number, style, figures, options, first name. */
export async function loadOrderBrief(tx: Tx, orderId: string): Promise<OrderBrief | null> {
  const [order] = await tx
    .select({
      id: orders.id,
      businessId: orders.businessId,
      platformOrderId: orders.platformOrderId,
      platformOrderName: orders.platformOrderName,
      customerId: orders.customerId,
      notes: orders.notes,
    })
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1);
  if (!order) return null;

  const items = await tx
    .select({
      figureCount: orderItems.figureCount,
      style: orderItems.style,
      title: orderItems.title,
      options: orderItems.options,
    })
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId));

  let figures: number | null = 0;
  let style: string | null = null;
  let title: string | null = null;
  let options: { name: string; value: string }[] = [];
  for (const it of items) {
    if (it.figureCount == null) figures = null;
    else if (figures != null) figures += it.figureCount;
    if (it.style && !style) style = it.style;
    if (it.title && !title) title = it.title;
    if (Array.isArray(it.options) && it.options.length && !options.length) options = it.options;
  }
  if (!items.length) figures = null;

  let customerFirstName: string | null = null;
  if (order.customerId) {
    // customer_public is the designer-safe projection (first name only).
    const [c] = await tx
      .select({ firstName: customerPublic.firstName })
      .from(customerPublic)
      .where(eq(customerPublic.id, order.customerId))
      .limit(1);
    customerFirstName = c?.firstName ?? null;
  }

  return {
    id: order.id,
    businessId: order.businessId,
    number: order.platformOrderName ?? order.platformOrderId,
    customerFirstName,
    style,
    figureCount: figures,
    title,
    options,
    notes: order.notes,
  };
}

function figuresText(n: number | null): string {
  if (n == null) return "figure count not confirmed yet";
  return `${n} figure${n === 1 ? "" : "s"}`;
}

function optionsText(options: { name: string; value: string }[]): string {
  return options
    .filter((o) => o.name && o.value)
    .map((o) => `${o.name}: ${o.value}`)
    .join(", ");
}

function deliverAfterFor(now: Date, contact: DesignerContact | null): Record<string, unknown> {
  if (!contact) return {};
  const end = quietWindowEnd(now, contact);
  return end ? { deliverAfter: end.toISOString() } : {};
}

function contactPayload(contact: DesignerContact | null): Record<string, unknown> {
  if (!contact) return {};
  return {
    designerId: contact.userId,
    channel: contact.preferredChannel,
    phone: contact.phone,
    timezone: contact.timezone,
  };
}

/**
 * The brief a designer gets the moment an order lands on their board. Called
 * from createAssignment (auto-assign, sweep reassign, manual reassign).
 */
export async function sendDesignerBrief(
  tx: Tx,
  input: { orderId: string; designerId: string; dueAt: Date | null; reason?: string | null; now?: Date },
): Promise<string | null> {
  const now = input.now ?? new Date();
  const [brief, contact] = await Promise.all([
    loadOrderBrief(tx, input.orderId),
    loadDesignerContact(tx, input.designerId),
  ]);
  if (!brief) return null;

  const lines: string[] = [];
  lines.push(`New order for you: ${brief.number}.`);
  if (brief.title) lines.push(`Product: ${brief.title}.`);
  lines.push(`Style: ${brief.style ?? "not set"}. ${figuresText(brief.figureCount)}.`);
  const opts = optionsText(brief.options);
  if (opts) lines.push(`Options: ${opts}.`);
  if (brief.notes) lines.push(`Notes: ${brief.notes}`);
  if (brief.customerFirstName) lines.push(`Customer: ${brief.customerFirstName}.`);
  lines.push(
    input.dueAt
      ? `Deadline: ${formatInTimezone(input.dueAt, contact?.timezone)}.`
      : "Deadline: not set yet.",
  );
  if (input.reason) lines.push(input.reason);
  const links = orderLinks(brief.id);
  lines.push(`Open it: ${links.boardUrl}`);

  return sendAlphaEvent(tx, {
    type: "designer.brief",
    businessId: brief.businessId,
    orderId: brief.id,
    toUserId: input.designerId,
    toRole: "designer",
    text: lines.join(" "),
    payload: {
      links,
      orderNumber: brief.number,
      style: brief.style,
      figureCount: brief.figureCount,
      options: brief.options,
      dueAt: input.dueAt?.toISOString() ?? null,
      dueAtLocal: input.dueAt ? formatInTimezone(input.dueAt, contact?.timezone) : null,
      ...contactPayload(contact),
      ...deliverAfterFor(now, contact),
    },
  });
}

/** 24 h after assignment with nothing uploaded. Respects quiet hours. */
export async function sendDesignerNudge(
  tx: Tx,
  input: { orderId: string; designerId: string; dueAt: Date | null; hoursSinceAssigned: number; now?: Date },
): Promise<string | null> {
  const now = input.now ?? new Date();
  const [brief, contact] = await Promise.all([
    loadOrderBrief(tx, input.orderId),
    loadDesignerContact(tx, input.designerId),
  ]);
  if (!brief) return null;
  const links = orderLinks(brief.id);
  const due = input.dueAt ? ` It is due ${formatInTimezone(input.dueAt, contact?.timezone)}.` : "";
  const text =
    `Quick check on order ${brief.number} (${brief.style ?? "no style"}, ${figuresText(brief.figureCount)}). ` +
    `It has been ${Math.floor(input.hoursSinceAssigned)} hours and no portrait has been uploaded yet.${due} ` +
    `If you cannot do it, reply now so it can be moved. Otherwise it moves to another designer at 48 hours. ` +
    `Upload here: ${links.boardUrl}`;
  return sendAlphaEvent(tx, {
    type: "designer.nudge",
    businessId: brief.businessId,
    orderId: brief.id,
    toUserId: input.designerId,
    toRole: "designer",
    text,
    payload: {
      links,
      orderNumber: brief.number,
      hoursSinceAssigned: Math.floor(input.hoursSinceAssigned),
      dueAt: input.dueAt?.toISOString() ?? null,
      ...contactPayload(contact),
      ...deliverAfterFor(now, contact),
    },
  });
}

/** 48 h: the order moved. Told to BOTH designers; an escalation, so no quiet-hours hold. */
export async function sendDesignerReassigned(
  tx: Tx,
  input: { orderId: string; fromDesignerId: string; toDesignerId: string; reason: string },
): Promise<void> {
  const [brief, from, to] = await Promise.all([
    loadOrderBrief(tx, input.orderId),
    loadDesignerContact(tx, input.fromDesignerId),
    loadDesignerContact(tx, input.toDesignerId),
  ]);
  if (!brief) return;
  const links = orderLinks(brief.id);
  const base = { businessId: brief.businessId, orderId: brief.id, toRole: "designer" as const };

  await sendAlphaEvent(tx, {
    ...base,
    type: "designer.reassigned",
    toUserId: input.fromDesignerId,
    text:
      `Order ${brief.number} has been moved to another designer. ${input.reason} ` +
      `You do not need to do anything more on it. It no longer shows on your board.`,
    payload: { links, orderNumber: brief.number, role: "previous", reason: input.reason, ...contactPayload(from) },
  });
  await sendAlphaEvent(tx, {
    ...base,
    type: "designer.reassigned",
    toUserId: input.toDesignerId,
    text:
      `Order ${brief.number} has been moved to you from another designer. ${input.reason} ` +
      `The brief with the details follows. Open it: ${links.boardUrl}`,
    payload: { links, orderNumber: brief.number, role: "new", reason: input.reason, ...contactPayload(to) },
  });
}

/** Something a VA must look at now. Escalation: never held. */
export async function sendVaAttention(
  tx: Tx,
  input: { businessId: string; orderId: string | null; text: string; payload?: Record<string, unknown> },
): Promise<string> {
  return sendAlphaEvent(tx, {
    type: "va.attention",
    businessId: input.businessId,
    orderId: input.orderId,
    toRole: "va",
    text: input.text,
    payload: {
      ...(input.orderId ? { links: orderLinks(input.orderId) } : {}),
      ...(input.payload ?? {}),
    },
  });
}

/** Labels of the items the VA marked failed, from the qc_checks snapshot + results. */
export function failedChecklistLabels(snapshot: unknown, results: unknown): string[] {
  const items = (snapshot as ChecklistSnapshot | null)?.items;
  if (!Array.isArray(items)) return [];
  const res = (results ?? {}) as ItemResults;
  return items.filter((it) => res[it.key] === false).map((it) => it.label);
}

/**
 * QC failed: tell the assigned designer exactly what to fix. Reads the newest
 * failed qc_checks row (the server-authoritative record) plus any annotation
 * pins the customer left on the last proof, so the message matches the card.
 */
export async function sendQcFeedback(tx: Tx, input: { orderId: string; now?: Date }): Promise<string | null> {
  const now = input.now ?? new Date();
  const [assignment] = await tx
    .select({ designerId: assignments.designerId, dueAt: assignments.dueAt })
    .from(assignments)
    .where(and(eq(assignments.orderId, input.orderId), eq(assignments.active, true)))
    .limit(1);
  if (!assignment) return null;

  const [check] = await tx
    .select({
      reason: qcChecks.reason,
      checklistSnapshot: qcChecks.checklistSnapshot,
      itemResults: qcChecks.itemResults,
    })
    .from(qcChecks)
    .where(and(eq(qcChecks.orderId, input.orderId), eq(qcChecks.result, "fail")))
    .orderBy(desc(qcChecks.createdAt))
    .limit(1);
  if (!check) return null;

  const [brief, contact] = await Promise.all([
    loadOrderBrief(tx, input.orderId),
    loadDesignerContact(tx, assignment.designerId),
  ]);
  if (!brief) return null;

  const failed = failedChecklistLabels(check.checklistSnapshot, check.itemResults);
  const [proof] = await tx
    .select({ annotations: proofs.annotations })
    .from(proofs)
    .where(and(eq(proofs.orderId, input.orderId), eq(proofs.decision, "revision")))
    .orderBy(desc(proofs.decidedAt))
    .limit(1);
  const pins = proof?.annotations ?? [];
  const links = orderLinks(brief.id);

  const parts: string[] = [`Order ${brief.number} did not pass QC.`];
  if (failed.length) parts.push(`Please fix: ${failed.join("; ")}.`);
  if (check.reason) parts.push(`Note from QC: ${check.reason}`);
  if (pins.length) parts.push(`There ${pins.length === 1 ? "is 1 pin" : `are ${pins.length} pins`} on the image showing where.`);
  parts.push(`Upload the fixed version here: ${links.boardUrl}`);

  return sendAlphaEvent(tx, {
    type: "designer.qc_feedback",
    businessId: brief.businessId,
    orderId: brief.id,
    toUserId: assignment.designerId,
    toRole: "designer",
    text: parts.join(" "),
    payload: {
      links,
      orderNumber: brief.number,
      failedItems: failed,
      reason: check.reason,
      annotations: pins,
      ...contactPayload(contact),
      ...deliverAfterFor(now, contact),
    },
  });
}
