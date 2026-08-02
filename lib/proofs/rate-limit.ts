import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { rateLimits } from "@/lib/db/schema";

export type RateLimitResult = { ok: boolean; retryAfter: number };

/**
 * Fixed-window rate limiter backed by the `rate_limits` table (no Redis, same
 * pattern as login throttling). One atomic upsert increments the counter for
 * `bucket`, resetting it when the window has rolled over.
 *
 * `rate_limits` has NO row-level security and holds no tenant data, so it is
 * queried with the raw `db` handle — this is deliberately outside the RLS
 * request path, because the proof portal has no signed-in user to scope by.
 *
 * `windowSec` is always a code-level constant (never user input), so it is safe
 * to interpolate into the interval expression.
 */
export async function checkRateLimit(
  bucket: string,
  limit: number,
  windowSec: number,
): Promise<RateLimitResult> {
  const rolledOver = sql`${rateLimits.windowStart} < now() - make_interval(secs => ${windowSec})`;

  const [row] = await db
    .insert(rateLimits)
    .values({ bucket, hits: 1, windowStart: sql`now()`, updatedAt: sql`now()` })
    .onConflictDoUpdate({
      target: rateLimits.bucket,
      set: {
        hits: sql`case when ${rolledOver} then 1 else ${rateLimits.hits} + 1 end`,
        windowStart: sql`case when ${rolledOver} then now() else ${rateLimits.windowStart} end`,
        updatedAt: sql`now()`,
      },
    })
    .returning({ hits: rateLimits.hits });

  const hits = row?.hits ?? 1;
  if (hits > limit) return { ok: false, retryAfter: windowSec };
  return { ok: true, retryAfter: 0 };
}

/** Best-effort client IP from proxy headers; falls back to a shared bucket. */
export function clientIp(headers: Headers): string {
  const xff = headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return headers.get("x-real-ip")?.trim() || "unknown";
}
