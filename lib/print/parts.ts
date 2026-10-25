import { and, desc, eq, like } from "drizzle-orm";

import type { Tx } from "@/lib/db";
import { messages, printJobs } from "@/lib/db/schema";
import { queueStageEmail } from "@/lib/email/dispatch";
import type { PrintProvider } from "@/lib/print/mapping";

/**
 * The parts of one order at the printer. Gelato splits a paid order whose products are made at different
 * production sites into connected orders (Lori PC32062: canvas + frame, Marissa 4205915832: poster + frame), and
 * the agent's print road writes a print_jobs row for each part with provider_payload.connectedTo = the paid order.
 *
 * The parts are the order's newest row and every row linked to it by printer order id, connectedTo or Gelato's own
 * connectedOrderIds, one per printer order id (a reconcile placeholder and a print road row for the same printer order
 * are one part; the tracked one wins, else the newest). A replacement is a new print with no link to the order it
 * replaced, so a delivered or cancelled original is never a part of it. A newest row with no printer id is the only
 * part (the reconcile-by-reference path). An order with one print is one part, exactly as before.
 */
export type PrintPart = {
  id: string;
  provider: PrintProvider;
  providerOrderId: string | null;
  reconcileState: string;
  providerStatus: string | null;
  submittedAt: Date | null;
  createdAt: Date;
  trackingNumber: string | null;
  trackingCompany: string | null;
  trackingUrl: string | null;
  shippedAt: Date | null;
  shopifyFulfillmentId: string | null;
  platformSyncedAt: Date | null;
  platformSyncError: string | null;
};

export type PrintPartRow = PrintPart & { providerPayload: unknown; providerResponse: unknown };

/** If the parts of an order ship further apart than this, the buyer hears about the first without waiting for the rest. */
export const PART_WAIT_MS = 3 * 24 * 60 * 60 * 1000;

function linkIds(row: PrintPartRow): string[] {
  const ids: string[] = [];
  if (row.providerOrderId) ids.push(row.providerOrderId);
  const to = (row.providerPayload as { connectedTo?: unknown } | null)?.connectedTo;
  for (const v of Array.isArray(to) ? to : [to]) if (typeof v === "string" && v) ids.push(v);
  const named = (row.providerResponse as { connectedOrderIds?: unknown } | null)?.connectedOrderIds;
  if (Array.isArray(named)) for (const v of named) if (typeof v === "string" && v) ids.push(v);
  return ids;
}

/** The parts among an order's print_jobs rows, given newest first (see PrintPart). Oldest part first. */
export function pickParts<T extends PrintPartRow>(rows: T[]): T[] {
  const anchor = rows[0];
  if (!anchor) return [];
  if (!anchor.providerOrderId) return [anchor];

  const ids = new Set(linkIds(anchor));
  const group = new Set<T>([anchor]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const row of rows) {
      if (group.has(row) || !row.providerOrderId) continue;
      const own = linkIds(row);
      if (!own.some((id) => ids.has(id))) continue;
      group.add(row);
      for (const id of own) ids.add(id);
      grew = true;
    }
  }

  const byPrinterId = new Map<string, T>();
  for (const row of rows) {
    if (!group.has(row)) continue;
    const seen = byPrinterId.get(row.providerOrderId!);
    if (!seen || (!seen.trackingNumber && row.trackingNumber)) byPrinterId.set(row.providerOrderId!, row);
  }
  return [...byPrinterId.values()].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

export async function loadPrintParts(tx: Tx, orderId: string): Promise<PrintPartRow[]> {
  const rows = await tx
    .select({
      id: printJobs.id,
      provider: printJobs.provider,
      providerOrderId: printJobs.providerOrderId,
      reconcileState: printJobs.reconcileState,
      providerStatus: printJobs.providerStatus,
      submittedAt: printJobs.submittedAt,
      createdAt: printJobs.createdAt,
      trackingNumber: printJobs.trackingNumber,
      trackingCompany: printJobs.trackingCompany,
      trackingUrl: printJobs.trackingUrl,
      shippedAt: printJobs.shippedAt,
      shopifyFulfillmentId: printJobs.shopifyFulfillmentId,
      platformSyncedAt: printJobs.platformSyncedAt,
      platformSyncError: printJobs.platformSyncError,
      providerPayload: printJobs.providerPayload,
      providerResponse: printJobs.providerResponse,
    })
    .from(printJobs)
    .where(eq(printJobs.orderId, orderId))
    .orderBy(desc(printJobs.createdAt));
  return pickParts(rows as PrintPartRow[]);
}

/** Tracking numbers the buyer has already been emailed (the shipped email's dedupe key carries them, "+" joined). */
export async function emailedTrackingNumbers(tx: Tx, orderId: string): Promise<Set<string>> {
  const prefix = `stage:${orderId}:shipped:`;
  const rows = await tx
    .select({ dedupeKey: messages.dedupeKey })
    .from(messages)
    .where(and(eq(messages.orderId, orderId), like(messages.dedupeKey, `${prefix}%`)));
  const told = new Set<string>();
  for (const { dedupeKey } of rows) {
    for (const n of (dedupeKey ?? "").slice(prefix.length).split("+")) if (n) told.add(n);
  }
  return told;
}

export type ShipmentNotice =
  /** No part has tracking yet. */
  | { kind: "none" }
  /** Some parts have shipped, the others have not, and it has been under PART_WAIT_MS (or the buyer already has these). */
  | { kind: "wait" }
  /** Every live part has tracking: the order is shipped; `untold` are the numbers the buyer has not had yet. */
  | { kind: "all"; untold: PrintPart[] }
  /** The parts ship more than PART_WAIT_MS apart: tell the buyer about the shipped ones now, the order stays printing. */
  | { kind: "early"; untold: PrintPart[] };

/** A part with no tracking that never will have any: cancelled or failed (problem), or delivered without a number. */
function settledWithoutTracking(part: PrintPart): boolean {
  return part.reconcileState === "problem" || (part.reconcileState === "shipped" && /deliver/i.test(part.providerStatus ?? ""));
}

/** What the buyer should hear about an order's parts now. A part that will never have tracking is not waited for. */
export function planShipmentNotice(parts: PrintPart[], emailed: Set<string>, now = new Date()): ShipmentNotice {
  const tracked = parts.filter((p) => p.trackingNumber);
  if (!tracked.length) return { kind: "none" };
  const untold = tracked.filter((p) => !emailed.has(p.trackingNumber!));
  const open = parts.filter((p) => !p.trackingNumber && !settledWithoutTracking(p));
  if (!open.length) return { kind: "all", untold };
  if (!untold.length) return { kind: "wait" };
  const first = Math.min(...untold.map((p) => (p.shippedAt ?? p.createdAt).getTime()));
  return now.getTime() - first > PART_WAIT_MS ? { kind: "early", untold } : { kind: "wait" };
}

function listWords(values: string[]): string {
  return values.length <= 1 ? (values[0] ?? "") : `${values.slice(0, -1).join(", ")} and ${values[values.length - 1]}`;
}

/**
 * The shipped email: every tracked part the buyer has not been told about, in one email ("Tracking number: A and
 * B"). Its dedupe key carries the numbers it lists, so a number is never emailed twice and a later part gets its own
 * short email. No tracked part at all = the plain shipped email, as before. Every number already emailed = nothing.
 */
export async function queueShippedEmail(
  tx: Tx,
  order: { id: string; businessId: string; customerId: string | null; platformOrderId: string; platformOrderName: string | null },
): Promise<string | null> {
  const parts = await loadPrintParts(tx, order.id);
  const tracked = parts.filter((p) => p.trackingNumber);
  if (!tracked.length) return queueStageEmail(tx, order, "shipped");
  const emailed = await emailedTrackingNumbers(tx, order.id);
  const untold = tracked.filter((p) => !emailed.has(p.trackingNumber!));
  if (!untold.length) return null;
  const numbers = untold.map((p) => p.trackingNumber!);
  return queueStageEmail(
    tx,
    order,
    "shipped",
    {
      tracking_number: listWords(numbers),
      tracking_url: listWords(untold.map((p) => p.trackingUrl).filter((u): u is string => !!u)) || undefined,
    },
    { moment: [...numbers].sort().join("+") },
  );
}
