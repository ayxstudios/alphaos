/**
 * Designer-bound Alpha events, in plain English. Every message a designer gets
 * from Alpha about an order is composed here so the wording, the links and the
 * privacy rule (first name only, never an email) live in one place.
 *
 *   sendDesignerBrief      new assignment (auto or manual)
 *   sendDesignerNudge      24 h with no portrait uploaded
 *   sendDesignerReassigned 48 h: the order moved to someone else (both told)
 *   sendQcFeedback         QC failed: the failed items + a link
 *   sendAiFixUsed          the owner sent the AI's fix of their portrait instead
 *   sendVaAttention        something a VA must look at now
 *
 * Quiet hours: a brief / nudge / QC feedback that would land inside the
 * designer's quiet window carries payload.deliverAfter = window end (the daemon
 * honours it). Escalations (reassigned, va.attention) never wait.
 */
import { and, asc, desc, eq } from "drizzle-orm";

import type { Tx } from "@/lib/db";
import { sendAlphaEvent } from "@/lib/alpha/client";
import { assignments, customerPublic, orderItems, orders, proofs, qcChecks } from "@/lib/db/schema";
import { loadDesignerContact, type DesignerContact } from "@/lib/designers/profile";
import { DEFAULT_TIMEZONE, formatInTimezone, isValidTimezone, quietWindowEnd } from "@/lib/designers/quiet-hours";
import { recordSameBuyerForDesigner } from "@/lib/orders/same-buyer";
import { portraitLinesOf } from "@/lib/orders/add-ons";
import { distinctStyles } from "@/lib/orders/order-styles";
import { loadClassifyConfig, pickPortraitItem } from "@/lib/orders/portrait-item";
import { clampItemQuantity } from "@/lib/orders/item-quantity";
import { portraitList } from "@/lib/orders/portrait-list";
import type { ChecklistSnapshot, ItemResults } from "@/lib/qc/checklist";
import { LOGIN_FREE_LINK_SECONDS, resolveAttachmentViews } from "@/lib/qc/attachment-urls";
import { isR2Configured, presignGet } from "@/lib/storage/r2";
import { appUrl } from "@/lib/urls";

/** One portrait line of an order, as a designer reads it; a line bought twice is two portrait numbers. */
export type BriefPortrait = {
  slots: number[];
  style: string | null;
  figureCount: number | null;
  title: string | null;
  options: { name: string; value: string }[];
};

type OrderBrief = {
  id: string;
  businessId: string;
  number: string;
  customerFirstName: string | null;
  style: string | null;
  /** Every portrait's style, the primary first (one entry on a one-style order). */
  styles: string[];
  figureCount: number | null;
  title: string | null;
  options: { name: string; value: string }[];
  /** Every portrait line in id order, add-ons left out (one entry on a one-line order). */
  portraits: BriefPortrait[];
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
      id: orderItems.id,
      sku: orderItems.sku,
      quantity: orderItems.quantity,
      figureCount: orderItems.figureCount,
      style: orderItems.style,
      title: orderItems.title,
      options: orderItems.options,
    })
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId))
    .orderBy(asc(orderItems.id));

  // The portrait lines only (2026-10-29): an add-on (Print & Ship, Fast Track)
  // has nothing to draw, and the primary portrait leads, never an add-on row.
  const cfg = items.length > 1 ? await loadClassifyConfig(tx, orderId) : null;
  const lines = portraitLinesOf(items, cfg);
  const primary = pickPortraitItem(lines, cfg);
  const ordered = primary ? [primary, ...lines.filter((it) => it !== primary)] : lines;
  const optionsOf = (it: (typeof items)[number]) => (Array.isArray(it.options) ? it.options : []);

  let figures: number | null = 0;
  let style: string | null = null;
  let title: string | null = null;
  let options: { name: string; value: string }[] = [];
  for (const it of lines) {
    if (it.figureCount == null) figures = null;
    else if (figures != null) figures += it.figureCount;
  }
  for (const it of ordered) {
    if (it.style && !style) style = it.style;
    if (it.title && !title) title = it.title;
    if (optionsOf(it).length && !options.length) options = optionsOf(it);
  }
  if (!lines.length) figures = null;
  let next = 1;
  const portraits: BriefPortrait[] = lines.map((it) => ({
    slots: Array.from({ length: clampItemQuantity(it.quantity) }, () => next++),
    style: it.style?.trim() || null,
    figureCount: it.figureCount,
    title: it.title,
    options: optionsOf(it),
  }));

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
    styles: distinctStyles(ordered.map((it) => it.style)),
    figureCount: figures,
    title,
    options,
    portraits,
    notes: order.notes,
  };
}

/** The style words a message uses: "Watercolor People + Disney Pet" on a two-style order. */
function briefStyleText(brief: OrderBrief, none: string): string {
  return brief.styles.length > 1 ? brief.styles.join(" + ") : (brief.style ?? none);
}

/**
 * One line per portrait on a 2+ portrait order (2026-10-29: two portraits in
 * two styles, the brief named only the first): style, figures, product and
 * options. Pure; empty on a one-portrait order, whose brief reads as before.
 */
export function portraitBriefLines(portraits: BriefPortrait[]): string[] {
  if (portraits.length < 2) return [];
  const total = portraits.reduce((n, p) => n + p.slots.length, 0);
  const out = [`This order has ${total} portraits, all for you: draw every one, the customer gets them together.`];
  portraits.forEach((p) => {
    const opts = optionsText(p.options);
    out.push(
      `${portraitList(p.slots)}: ${p.style ?? "style not set"}, ${figuresText(p.figureCount)}${p.title ? `, ${p.title}` : ""}.` +
        (opts ? ` Options: ${opts}.` : ""),
    );
  });
  return out;
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
  input: {
    orderId: string;
    designerId: string;
    dueAt: Date | null;
    reason?: string | null;
    /** Portraits in 2+ styles and this designer does not list them all: which one they draw in its own style. */
    styleNote?: string | null;
    now?: Date;
  },
): Promise<string | null> {
  const now = input.now ?? new Date();
  const [brief, contact] = await Promise.all([
    loadOrderBrief(tx, input.orderId),
    loadDesignerContact(tx, input.designerId),
  ]);
  if (!brief) return null;
  // One buyer, several orders: when this buyer has other orders the designer is
  // told so (order numbers and products only, never a name, email or address),
  // and the same note is kept on the order for the board card. Null otherwise.
  const sameBuyer = await recordSameBuyerForDesigner(tx, brief.id);

  const lines: string[] = [];
  lines.push(`New order for you: ${brief.number}.`);
  const perPortrait = portraitBriefLines(brief.portraits);
  if (perPortrait.length) {
    lines.push(...perPortrait);
    if (input.styleNote) lines.push(input.styleNote);
  } else {
    if (brief.title) lines.push(`Product: ${brief.title}.`);
    lines.push(`Style: ${brief.style ?? "not set"}. ${figuresText(brief.figureCount)}.`);
    const opts = optionsText(brief.options);
    if (opts) lines.push(`Options: ${opts}.`);
  }
  if (brief.notes) lines.push(`Notes: ${brief.notes}`);
  if (sameBuyer) lines.push(sameBuyer);
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
      ...(brief.portraits.length > 1 ? { styles: brief.styles, portraits: brief.portraits } : {}),
      ...(input.styleNote ? { styleNote: input.styleNote } : {}),
      sameBuyer,
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
    `Quick check on order ${brief.number} (${briefStyleText(brief, "no style")}, ${figuresText(brief.figureCount)}). ` +
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

/**
 * Yousif 2026-10-14: an order already back with its designer after a QC fail
 * was just marked urgent and its fix deadline shortened. Alpha tells the
 * designer straight away (no quiet-hours hold) instead of waiting for the
 * chaser's next round.
 */
export async function sendQcFixUrgent(
  tx: Tx,
  input: { orderId: string; designerId: string; dueAt: Date; now?: Date },
): Promise<string | null> {
  const now = input.now ?? new Date();
  const [brief, contact] = await Promise.all([
    loadOrderBrief(tx, input.orderId),
    loadDesignerContact(tx, input.designerId),
  ]);
  if (!brief) return null;
  const links = orderLinks(brief.id);
  const deadline = qcFeedbackDeadline(input.dueAt, now, contact?.timezone, true);
  const text =
    `${deadline?.urgentLine ?? "URGENT: the customer is waiting."} ` +
    `Order ${brief.number} is now urgent. It is the QC fix you already have, nothing new to read. ` +
    `Upload the fixed version here: ${links.boardUrl}`;
  return sendAlphaEvent(tx, {
    type: "designer.qc_fix_urgent",
    businessId: brief.businessId,
    orderId: brief.id,
    toUserId: input.designerId,
    toRole: "designer",
    text,
    payload: { links, orderNumber: brief.number, urgent: true, dueAt: input.dueAt.toISOString(), ...contactPayload(contact) },
  });
}

/**
 * Yousif 2026-10-14: the owner sent the AI's fix of this designer's portrait
 * to the customer instead of their version, and "that should now be the
 * portrait we work with". Alpha tells the designer what was changed and that
 * any later revision starts from the fixed file (the newest on their card).
 * Not urgent, so it waits out quiet hours.
 */
export async function sendAiFixUsed(
  tx: Tx,
  input: { orderId: string; fixed: string[]; fixKeys: string[]; now?: Date },
): Promise<string | null> {
  const now = input.now ?? new Date();
  const [assignment] = await tx
    .select({ designerId: assignments.designerId })
    .from(assignments)
    .where(and(eq(assignments.orderId, input.orderId), eq(assignments.active, true)))
    .limit(1);
  if (!assignment) return null;
  const [brief, contact] = await Promise.all([
    loadOrderBrief(tx, input.orderId),
    loadDesignerContact(tx, assignment.designerId),
  ]);
  if (!brief) return null;
  const links = orderLinks(brief.id);
  // The board needs a login, so the fixed picture is its own signed link (private bucket, 7 days).
  const pictures: string[] = [];
  if (isR2Configured()) {
    for (const key of input.fixKeys) {
      try { pictures.push(await presignGet(key, LOGIN_FREE_LINK_SECONDS)); } catch { /* the card still has it */ }
    }
  }
  const parts: string[] = [];
  parts.push(`Order ${brief.number}: QC found a few things to fix, so we fixed them ourselves and sent the fixed version to the customer.`);
  if (input.fixed.length) parts.push(`What was changed: ${input.fixed.join("; ")}.`);
  parts.push("The fixed version is now the main file for this order. If the customer asks for changes, start from the newest version on your card, not your original.");
  pictures.forEach((url, i) => parts.push(`${pictures.length > 1 ? `Fixed version ${i + 1}` : "Fixed version"}: ${url}`));
  parts.push(`Open it: ${links.boardUrl}`);
  return sendAlphaEvent(tx, {
    type: "designer.ai_fix_used",
    businessId: brief.businessId,
    orderId: brief.id,
    toUserId: assignment.designerId,
    toRole: "designer",
    text: parts.join(" "),
    payload: { links, orderNumber: brief.number, fixed: input.fixed, pictures, ...contactPayload(contact), ...deliverAfterFor(now, contact) },
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

function clockInTimezone(at: Date, tz: string | null | undefined, withDay: boolean): string {
  const zone = isValidTimezone(tz) ? tz : DEFAULT_TIMEZONE;
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: zone,
    ...(withDay ? { weekday: "short" as const } : {}),
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
    .format(at)
    .replace(",", "");
}

/**
 * The exact deadline sentence for a QC-fail message, in the designer's own
 * timezone, from the real assignment due_at (never a hard-coded number of
 * hours). Urgent orders get an URGENT first line instead of the plain sentence.
 */
export function qcFeedbackDeadline(
  dueAt: Date | null,
  now: Date,
  tz: string | null | undefined,
  urgent: boolean,
): { urgentLine: string | null; normalLine: string | null } | null {
  if (!dueAt) return null;
  const hours = Math.max(1, Math.round((dueAt.getTime() - now.getTime()) / 3600000));
  if (urgent) {
    return {
      urgentLine: `URGENT: the customer is waiting. Please upload the fix within ${hours} hour${hours === 1 ? "" : "s"}, by ${clockInTimezone(dueAt, tz, false)} your time.`,
      normalLine: null,
    };
  }
  return { urgentLine: null, normalLine: `Please upload the fix by ${clockInTimezone(dueAt, tz, true)} your time (${hours} h).` };
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
      attachments: qcChecks.attachments,
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
  // The board link needs a login, so each picture is its own signed link that
  // opens straight in the phone (private bucket, valid 7 days).
  const pictures = await resolveAttachmentViews(check.attachments, LOGIN_FREE_LINK_SECONDS);

  const [urgentRow] = await tx.select({ urgentAt: orders.urgentAt }).from(orders).where(eq(orders.id, input.orderId)).limit(1);
  const parts: string[] = [];
  const deadline = qcFeedbackDeadline(assignment.dueAt, now, contact?.timezone, !!urgentRow?.urgentAt);
  if (deadline?.urgentLine) parts.push(deadline.urgentLine);
  parts.push(`Order ${brief.number} did not pass QC.`);
  if (failed.length) parts.push(`Please fix: ${failed.join("; ")}.`);
  if (check.reason) parts.push(`Note from QC: ${check.reason}`);
  pictures.forEach((p, i) => parts.push(`Picture ${i + 1}: ${p.url}`));
  if (pins.length) parts.push(`There ${pins.length === 1 ? "is 1 pin" : `are ${pins.length} pins`} on the image showing where.`);
  if (deadline?.normalLine) parts.push(deadline.normalLine);
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
      urgent: !!urgentRow?.urgentAt,
      dueAt: assignment.dueAt ? assignment.dueAt.toISOString() : null,
      reason: check.reason,
      annotations: pins,
      pictures: pictures.map((p) => ({ filename: p.filename, url: p.url })),
      ...contactPayload(contact),
      // An urgent fix has a short clock: no quiet-hours hold.
      ...(urgentRow?.urgentAt ? {} : deliverAfterFor(now, contact)),
    },
  });
}
