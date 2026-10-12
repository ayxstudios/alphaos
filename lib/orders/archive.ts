import { and, eq, isNotNull, isNull, sql, type SQL } from "drizzle-orm";

import type { Tx } from "@/lib/db";
import { activityLog, orderItems, orders } from "@/lib/db/schema";
import { etsyImportItems } from "@/lib/integrations/etsy/receipt-review";
import { mergeImportItems, type ImportItem } from "@/lib/orders/reconcile";

export const BACKFILL_CUTOFF_KEY = "backfillCutoffAt";

export function todayCutoffIso(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

export function parseBackfillCutoff(config: Record<string, unknown> | null | undefined): Date {
  const raw = config?.[BACKFILL_CUTOFF_KEY];
  if (typeof raw === "string") {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date(0);
}

export function isBeforeBackfillCutoff(placedAt: Date, config: Record<string, unknown> | null | undefined): boolean {
  return placedAt.getTime() < parseBackfillCutoff(config).getTime();
}

export function ensureBackfillCutoff<T extends Record<string, unknown> | null | undefined>(
  config: T,
  now = new Date(),
): Record<string, unknown> {
  const current = (config ?? {}) as Record<string, unknown>;
  if (typeof current[BACKFILL_CUTOFF_KEY] === "string" && current[BACKFILL_CUTOFF_KEY]) return current;
  return { ...current, [BACKFILL_CUTOFF_KEY]: todayCutoffIso(now) };
}

export function liveOrderWhere(): SQL {
  return isNull(orders.archivedAt);
}

export function liveOrderSql(): SQL {
  return sql`${orders.archivedAt} is null`;
}

/**
 * The item rows an order should have, rebuilt from the platform payload the
 * importer kept in `orders.raw_import`, with the importers' own builder. Only
 * Etsy keeps its payload (and was header only until 2026-10-05, so older orders
 * have no rows); the Shopify importer writes its rows at import time, archived
 * orders included. Stubs (legacy intake, Gmail sale email, Trello) carry no
 * transactions and give nothing. Figure count and style are never guessed: the
 * rows come out the way the importer leaves them, for a VA to resolve.
 */
export function importItemsFromRawImport(source: string | null | undefined, rawImport: unknown): ImportItem[] {
  return source === "etsy" ? etsyImportItems(rawImport) : [];
}

export type ReviveReason = "revision";

/**
 * A customer revision on an archived order makes it live work again. Runs in
 * the caller's transaction (runTransition holds the order row lock): clears the
 * archive flag so the order is back in every list, board and sweep, builds the
 * item rows when the old process never created any, and writes the
 * `order.unarchived` activity row. A no-op for an order that is not archived.
 * `canWriteItems` is false for a designer, who cannot write order_items.
 */
/** How long a revived order's revision gets before it counts as overdue. */
export const REVIVED_REVISION_DUE_HOURS = 48;

/** The new deadline for a revived order, or null when its own is still ahead. */
export function revivedDueAt(current: Date | null, now: Date): Date | null {
  if (current && current.getTime() > now.getTime()) return null;
  return new Date(now.getTime() + REVIVED_REVISION_DUE_HOURS * 60 * 60 * 1000);
}

export async function reviveArchivedOrder(
  tx: Tx,
  args: { orderId: string; businessId: string; actorId: string | null; reason: ReviveReason; canWriteItems?: boolean },
): Promise<{ revived: boolean; itemsCreated: number }> {
  const [order] = await tx
    .select({
      archivedAt: orders.archivedAt,
      archiveReason: orders.archiveReason,
      dueAt: orders.dueAt,
      source: orders.source,
      rawImport: orders.rawImport,
    })
    .from(orders)
    .where(eq(orders.id, args.orderId))
    .for("update");
  if (!order?.archivedAt) return { revived: false, itemsCreated: 0 };

  // An archived order's deadline is long gone. Kept as is, the revision would
  // be "overdue" the moment it lands and escalate to admins every day, so it
  // gets a fresh revision deadline (the old one stays in the activity row).
  const now = new Date();
  const dueAt = revivedDueAt(order.dueAt, now);
  await tx
    .update(orders)
    .set({ archivedAt: null, archiveReason: null, updatedAt: now, ...(dueAt ? { dueAt } : {}) })
    .where(and(eq(orders.id, args.orderId), isNotNull(orders.archivedAt)));

  let itemsCreated = 0;
  if (args.canWriteItems !== false) {
    const [anyItem] = await tx
      .select({ id: orderItems.id })
      .from(orderItems)
      .where(eq(orderItems.orderId, args.orderId))
      .limit(1);
    const importItems = anyItem ? [] : importItemsFromRawImport(order.source, order.rawImport);
    if (importItems.length) {
      const merged = await mergeImportItems(tx, { businessId: args.businessId, orderId: args.orderId, importItems });
      itemsCreated = merged.inserted;
    }
  }

  await tx.insert(activityLog).values({
    businessId: args.businessId,
    orderId: args.orderId,
    actorId: args.actorId,
    action: "order.unarchived",
    metadata: {
      reason: args.reason,
      itemsCreated,
      previousArchiveReason: order.archiveReason,
      ...(dueAt ? { previousDueAt: order.dueAt?.toISOString() ?? null, dueAt: dueAt.toISOString() } : {}),
    },
  });
  return { revived: true, itemsCreated };
}
