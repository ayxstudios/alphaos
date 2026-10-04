/**
 * Designer invoice links and month maths (pure, safe in client components).
 * A period is a UTC month, "YYYY-MM", the same key earnings.period uses.
 */
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isPeriod(value: unknown): value is string {
  return typeof value === "string" && PERIOD_RE.test(value);
}

/** The current UTC month, "2026-10". */
export function currentUtcPeriod(date = new Date()): string {
  return date.toISOString().slice(0, 7);
}

/** "2026-10" -> "October 2026". */
export function periodLabel(period: string): string {
  const [y, m] = period.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

/** "2026-10", -1 -> "2026-09"; "2026-12", 1 -> "2027-01". */
export function shiftPeriod(period: string, months: number): string {
  const [y, m] = period.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 + months, 1)).toISOString().slice(0, 7);
}

export function invoiceHref(designerId: string, period: string = currentUtcPeriod()): string {
  return `/invoice?${new URLSearchParams({ designer: designerId, period }).toString()}`;
}
