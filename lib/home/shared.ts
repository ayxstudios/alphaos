import { sql, type SQL } from "drizzle-orm";

import type { OrderStatus } from "@/lib/orders/transitions";

export const TZ = "Australia/Melbourne";
const DAY = 86_400_000;

/** 'YYYY-MM-DD' in Melbourne for a Date. */
export function dayKey(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/** The last `n` calendar days (oldest first), keys + short labels. */
export function lastDays(n: number, now = new Date()): { key: string; label: string }[] {
  const out: { key: string; label: string }[] = [];
  const fmt = new Intl.DateTimeFormat("en-AU", { timeZone: TZ, weekday: "short", day: "numeric" });
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * DAY);
    out.push({ key: dayKey(d), label: fmt.format(d).replace(",", "") });
  }
  return out;
}

export function sinceDays(n: number, now = new Date()): Date {
  return new Date(now.getTime() - n * DAY);
}

/** SQL: a timestamp column bucketed to a Melbourne 'YYYY-MM-DD'. */
export function dayBucket(col: SQL | { getSQL(): SQL }): SQL<string> {
  // The zone is inlined (not a bound parameter) so the SELECT and GROUP BY
  // expressions are byte-identical; Postgres treats $1 and $4 as different.
  return sql<string>`to_char(timezone(${sql.raw(`'${TZ}'`)}, ${col}), 'YYYY-MM-DD')`;
}

/** Fill a day series from grouped rows. */
export function fillDays(days: { key: string }[], rows: { day: string; n: number | string }[]): number[] {
  const map = new Map(rows.map((r) => [r.day, Number(r.n)]));
  return days.map((d) => map.get(d.key) ?? 0);
}

/**
 * Five stage families, fixed order and colour (chart-1..5 semantics):
 * waiting on customer (amber), design (violet), print and ship (blue),
 * held (rose), done (teal). Colour follows the family, never its size.
 */
export type StageKey = "customer" | "design" | "print" | "held" | "done";
export const STAGES: { key: StageKey; label: string; color: "c3" | "c1" | "c5" | "c4" | "c2"; statuses: OrderStatus[] }[] = [
  { key: "customer", label: "Waiting on customer", color: "c3", statuses: ["awaiting_details", "awaiting_photos", "awaiting_approval"] },
  { key: "design", label: "In design", color: "c1", statuses: ["ready_to_assign", "in_design", "awaiting_qc"] },
  { key: "print", label: "Print and ship", color: "c5", statuses: ["approved", "printing", "shipped", "fulfillment_only"] },
  { key: "held", label: "Held", color: "c4", statuses: ["on_hold", "triage"] },
  { key: "done", label: "Done", color: "c2", statuses: ["delivered", "complete"] },
];

/** Statuses that count as open work (not finished, not cancelled). */
export const OPEN_STATUSES: OrderStatus[] = [
  "awaiting_details",
  "awaiting_photos",
  "awaiting_approval",
  "ready_to_assign",
  "in_design",
  "awaiting_qc",
  "approved",
  "printing",
  "shipped",
  "fulfillment_only",
  "on_hold",
  "triage",
];

/** Statuses where a due date can still be missed. */
export const DUE_STATUSES: OrderStatus[] = [
  "awaiting_details",
  "awaiting_photos",
  "awaiting_approval",
  "ready_to_assign",
  "in_design",
  "awaiting_qc",
  "approved",
  "printing",
  "triage",
];

export function stageCounts(byStatus: { status: string; n: number }[]): { key: StageKey; label: string; color: (typeof STAGES)[number]["color"]; n: number }[] {
  const map = new Map(byStatus.map((r) => [r.status, Number(r.n)]));
  return STAGES.map((s) => ({ key: s.key, label: s.label, color: s.color, n: s.statuses.reduce((a, st) => a + (map.get(st) ?? 0), 0) }));
}

/** null = no previous window to compare (shows "new"); undefined = nothing either way (no pill). */
export function pctDelta(now: number, prev: number): number | null | undefined {
  if (prev === 0) return now === 0 ? undefined : null;
  return Math.round(((now - prev) / prev) * 100);
}

export function greetingFor(now = new Date()): string {
  const hour = Number(new Intl.DateTimeFormat("en-AU", { hour: "numeric", hour12: false, timeZone: TZ }).format(now));
  return hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
}
