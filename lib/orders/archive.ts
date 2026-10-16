import { and, isNotNull, isNull, notInArray, sql, type SQL } from "drizzle-orm";

import { orders } from "@/lib/db/schema";

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

// Archived is not done (clean slating audit, 2026-10-16, deck af027ad3beb2831a):
// 86 orders were archived while still owed (PixArt 66, CPS 20, mostly the
// "pre 2026-10-03" sweep and the backfill cutoff), so every live-only query
// (overdue counts, the census, the agent APIs) stopped seeing them, including
// PC32186 whose buyer asked "has my order shipped?" after it was archived. An
// archived order is only finished when its status says so.
export const ARCHIVE_FINISHED_STATUSES = ["cancelled", "complete", "delivered", "shipped"] as const;

/** Archived orders that are still owed: not delivered, shipped, complete or cancelled. */
export function archivedUnfinishedWhere(): SQL {
  return and(isNotNull(orders.archivedAt), notInArray(orders.status, [...ARCHIVE_FINISHED_STATUSES]))!;
}

// Archived on purpose because nothing is owed (an owner or VA wrote why): a
// duplicate placeholder, an Etsy receipt that no longer exists, "ignore this
// order". Buyer words never revive these by themselves; they stay visible with
// their reason so a person decides. Every other archive reason (the bulk
// sweeps, none, "revive if the buyer writes") reopens on buyer words.
const SETTLED_ARCHIVE_REASON = /^\s*(duplicate placeholder|not needed)\b|\bignore this order\b/i;

export function isSettledArchiveReason(reason: string | null | undefined): boolean {
  return !!reason && SETTLED_ARCHIVE_REASON.test(reason);
}
