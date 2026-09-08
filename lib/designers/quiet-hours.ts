/**
 * Timezone + quiet-hours helpers for designer messaging. Pure functions, no DB.
 *
 * Designers work from phones across Indonesia / the Philippines, so every
 * deadline they read is rendered in THEIR IANA timezone, and a message that
 * would land inside their quiet window is held until the window ends.
 */

export const DEFAULT_TIMEZONE = "Asia/Jakarta";

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isValidTimezone(tz: string | null | undefined): tz is string {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function isValidHHMM(v: string | null | undefined): v is string {
  return !!v && HHMM.test(v);
}

/** E.164: "+" then 8..15 digits, first digit 1-9. */
export function isValidE164(v: string | null | undefined): v is string {
  return !!v && /^\+[1-9]\d{7,14}$/.test(v);
}

export function normalizePhone(raw: string): string {
  const digits = raw.replace(/[^\d+]/g, "");
  if (!digits) return "";
  return digits.startsWith("+") ? "+" + digits.slice(1).replace(/\+/g, "") : "+" + digits;
}

type LocalParts = { y: number; mo: number; d: number; h: number; mi: number; s: number };

function localParts(at: Date, tz: string): LocalParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p: Record<string, number> = {};
  for (const part of fmt.formatToParts(at)) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  return { y: p.year, mo: p.month, d: p.day, h: p.hour === 24 ? 0 : p.hour, mi: p.minute, s: p.second };
}

/** The UTC instant of a wall-clock time in `tz` (two-pass offset correction). */
export function zonedTimeToUtc(parts: { y: number; mo: number; d: number; h: number; mi: number }, tz: string): Date {
  const asUtc = Date.UTC(parts.y, parts.mo - 1, parts.d, parts.h, parts.mi, 0);
  let guess = asUtc;
  for (let i = 0; i < 2; i++) {
    const lp = localParts(new Date(guess), tz);
    const seen = Date.UTC(lp.y, lp.mo - 1, lp.d, lp.h, lp.mi, lp.s);
    guess += asUtc - seen;
  }
  return new Date(guess);
}

/**
 * If `now` falls inside the designer's quiet window, return the instant the
 * window ends (when the message may be delivered); otherwise null. Handles
 * windows that wrap past midnight (22:00 -> 07:00). Any invalid input = no
 * quiet window.
 */
export function quietWindowEnd(
  now: Date,
  profile: { timezone?: string | null; quietStart?: string | null; quietEnd?: string | null },
): Date | null {
  const tz = isValidTimezone(profile.timezone) ? profile.timezone : DEFAULT_TIMEZONE;
  if (!isValidHHMM(profile.quietStart) || !isValidHHMM(profile.quietEnd)) return null;
  if (profile.quietStart === profile.quietEnd) return null;

  const [sh, sm] = profile.quietStart.split(":").map(Number);
  const [eh, em] = profile.quietEnd.split(":").map(Number);
  const start = sh * 60 + sm;
  const end = eh * 60 + em;
  const lp = localParts(now, tz);
  const cur = lp.h * 60 + lp.mi;

  let inside: boolean;
  let endDayOffset = 0;
  if (start < end) {
    inside = cur >= start && cur < end;
  } else {
    // wraps midnight
    inside = cur >= start || cur < end;
    if (inside && cur >= start) endDayOffset = 1;
  }
  if (!inside) return null;

  const endLocal = new Date(Date.UTC(lp.y, lp.mo - 1, lp.d + endDayOffset, eh, em));
  return zonedTimeToUtc(
    { y: endLocal.getUTCFullYear(), mo: endLocal.getUTCMonth() + 1, d: endLocal.getUTCDate(), h: eh, mi: em },
    tz,
  );
}

/** "Wed 10 Sep, 3:00 pm (Asia/Jakarta)" */
export function formatInTimezone(at: Date, tz: string | null | undefined, withZone = true): string {
  const zone = isValidTimezone(tz) ? tz : DEFAULT_TIMEZONE;
  const text = new Intl.DateTimeFormat("en-AU", {
    timeZone: zone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(at);
  return withZone ? `${text} (${zone})` : text;
}

/** Short zone label for a UI badge: "GMT+7". */
export function zoneOffsetLabel(tz: string | null | undefined, at = new Date()): string {
  const zone = isValidTimezone(tz) ? tz : DEFAULT_TIMEZONE;
  const part = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "shortOffset" })
    .formatToParts(at)
    .find((p) => p.type === "timeZoneName");
  return part?.value ?? zone;
}

/** Start of the current week (Monday 00:00) in the designer's timezone, as UTC. */
export function startOfWeekInTimezone(now: Date, tz: string | null | undefined): Date {
  const zone = isValidTimezone(tz) ? tz : DEFAULT_TIMEZONE;
  const lp = localParts(now, zone);
  const localMidnight = new Date(Date.UTC(lp.y, lp.mo - 1, lp.d));
  const dow = (localMidnight.getUTCDay() + 6) % 7; // Mon = 0
  localMidnight.setUTCDate(localMidnight.getUTCDate() - dow);
  return zonedTimeToUtc(
    { y: localMidnight.getUTCFullYear(), mo: localMidnight.getUTCMonth() + 1, d: localMidnight.getUTCDate(), h: 0, mi: 0 },
    zone,
  );
}

/** Common designer timezones for the profile picker (any valid IANA name is accepted). */
export const TIMEZONE_OPTIONS = [
  "Asia/Jakarta",
  "Asia/Makassar",
  "Asia/Jayapura",
  "Asia/Manila",
  "Asia/Ho_Chi_Minh",
  "Asia/Bangkok",
  "Asia/Kuala_Lumpur",
  "Asia/Kolkata",
  "Asia/Dhaka",
  "Asia/Karachi",
  "Europe/London",
  "Europe/Kyiv",
  "America/Sao_Paulo",
  "America/New_York",
  "America/Los_Angeles",
  "Australia/Melbourne",
  "UTC",
] as const;
