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
