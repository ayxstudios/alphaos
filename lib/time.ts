/**
 * One place for showing a moment to staff. Every date and time on the app is
 * shown in the business's own zone (Melbourne), and any time of day carries the
 * short zone name ("5:31 pm AEST"), so a server-rendered page on Vercel (UTC)
 * and the same component hydrating in a browser print the SAME string: no
 * UTC-looking times, no hydration mismatch. Dependency-free so client
 * components can import it.
 */
export const APP_TIME_ZONE = "Australia/Melbourne";

export type When = Date | string | number | null | undefined;

function toDate(value: When): Date | null {
  if (value == null || value === "") return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

/**
 * Format `value` with the given Intl parts in Melbourne time (en-AU). A format
 * that shows the hour or minute gets the zone name appended. Returns `fallback`
 * for a missing or invalid value.
 */
export function formatAt(value: When, options: Intl.DateTimeFormatOptions, fallback = ""): string {
  const d = toDate(value);
  if (!d) return fallback;
  const showsTime = options.hour !== undefined || options.minute !== undefined;
  return new Intl.DateTimeFormat("en-AU", {
    ...options,
    timeZone: APP_TIME_ZONE,
    ...(showsTime ? { timeZoneName: "short" as const } : {}),
  }).format(d);
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Melbourne wall clock offset from UTC (ms) at the given instant. */
function zoneOffsetMs(at: Date): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: APP_TIME_ZONE,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  const wall = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
  return wall - at.getTime();
}

/**
 * The value for an <input type="date"> (yyyy-mm-dd) showing the Melbourne
 * calendar day of `value`. Pairs with parseDueDate so a saved date never
 * drifts: the day the person sees is the day that gets stored.
 */
export function dateInputValue(value: When): string {
  const d = toDate(value);
  if (!d) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: APP_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/**
 * A due date typed as yyyy-mm-dd means "by the end of that day in Melbourne",
 * so it is stored as 23:59:59 Melbourne time on that day. Anything else (a
 * full ISO timestamp) is taken as is.
 */
export function parseDueDate(input: string): Date {
  if (!DATE_ONLY.test(input)) return new Date(input);
  const [y, m, d] = input.split("-").map(Number);
  const wall = Date.UTC(y, m - 1, d, 23, 59, 59);
  return new Date(wall - zoneOffsetMs(new Date(wall)));
}
