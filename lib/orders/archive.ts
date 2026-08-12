import { isNull, sql, type SQL } from "drizzle-orm";

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
