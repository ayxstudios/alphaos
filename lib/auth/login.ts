import { CredentialsSignin } from "next-auth";
import { eq, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { users, loginAttempts, rateLimits } from "@/lib/db/schema";
import { verifyPassword } from "./password";
import type { Role } from "./config";

const MAX_FAILED = 10;
const LOCK_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Per-IP limit, next to the per-email lockout (security QA 2026-09-23 P2): the
 * email lockout alone let one address spray passwords across every account.
 * Only FAILED attempts count, so a team behind one office NAT signing in at
 * shift start is never throttled; 30 failures in 15 minutes from one IP locks
 * that IP (every email) until the window rolls over. Stored in `rate_limits`
 * (no RLS, no tenant data) under `login-ip:<ip>`.
 */
export const IP_MAX_FAILED = 30;
export const IP_WINDOW_SEC = 15 * 60;

/** Distinct error so the login form can show the lockout message. */
export class AccountLockedError extends CredentialsSignin {
  code = "locked";
}

export type AuthedUser = {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  image: string | null;
};

/**
 * Verify credentials with database-backed rate limiting.
 *
 * Uses the raw `db` handle deliberately: this runs before any session exists,
 * against `user` (SELECT open to every context, 0040) and `login_attempts`
 * (no RLS). Returns the user on
 * success, `null` on bad credentials, and throws AccountLockedError when the
 * email is locked out (10 failures → 15-minute lock).
 */
export async function authenticate(
  rawEmail: string,
  password: string,
  ip: string | null = null,
): Promise<AuthedUser | null> {
  const email = rawEmail.trim().toLowerCase();
  const now = new Date();

  // Checked before the user lookup and bcrypt, so a throttled IP costs nothing.
  if (ip && (await ipFailures(ip)) >= IP_MAX_FAILED) {
    throw new AccountLockedError();
  }

  const [attempt] = await db
    .select()
    .from(loginAttempts)
    .where(eq(loginAttempts.email, email));

  if (attempt?.lockedUntil && attempt.lockedUntil > now) {
    throw new AccountLockedError();
  }

  // Named columns (not select *) so a column added later never breaks sign-in
  // on a database the migration has not reached yet.
  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
      image: users.image,
      active: users.active,
      passwordHash: users.passwordHash,
    })
    .from(users)
    .where(eq(users.email, email));
  // A deactivated account (user.active = false) fails exactly like a wrong
  // password: null, and the login form's calm "ask your admin" line.
  const ok =
    !!user?.passwordHash &&
    user.active &&
    (await verifyPassword(password, user.passwordHash));

  if (!ok) {
    await registerFailure(email, attempt?.failedCount ?? 0, now);
    if (ip) await registerIpFailure(ip);
    return null;
  }

  // Success — clear any recorded failures.
  if (attempt) {
    await db.delete(loginAttempts).where(eq(loginAttempts.email, email));
  }

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    image: user.image,
  };
}

async function registerFailure(
  email: string,
  prevCount: number,
  now: Date,
): Promise<void> {
  const count = prevCount + 1;
  const locked = count >= MAX_FAILED;
  const set = {
    // Reset the counter once we lock, so a fresh window starts after expiry.
    failedCount: locked ? 0 : count,
    lockedUntil: locked ? new Date(now.getTime() + LOCK_MS) : null,
    updatedAt: now,
  };
  await db
    .insert(loginAttempts)
    .values({ email, ...set })
    .onConflictDoUpdate({ target: loginAttempts.email, set });
}

/**
 * The client IP for the per-IP limit, from the request Auth.js hands to
 * authorize(). On Vercel `x-forwarded-for` is set by the edge (a client-sent
 * value is overwritten, proven on staging), first entry = the client. Null when
 * there is no proxy header (local dev, scripts): no per-IP limit then, rather
 * than one shared bucket for everyone.
 */
export function loginClientIp(headers: Headers | null | undefined): string | null {
  if (!headers) return null;
  const xff = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = xff || headers.get("x-real-ip")?.trim() || "";
  return ip ? ip.slice(0, 64) : null;
}

const ipBucket = (ip: string) => `login-ip:${ip}`;

/**
 * Failures from this IP in the current window (0 once the window rolled over).
 * Exported with registerIpFailure for the sign-in link provider (./login-link.ts),
 * which shares this limit: a bad link counts like a bad password.
 */
export async function ipFailures(ip: string): Promise<number> {
  const [row] = await db
    .select({
      hits: rateLimits.hits,
      live: sql<boolean>`${rateLimits.windowStart} >= now() - make_interval(secs => ${IP_WINDOW_SEC})`,
    })
    .from(rateLimits)
    .where(eq(rateLimits.bucket, ipBucket(ip)));
  return row?.live ? row.hits : 0;
}

/** One atomic upsert: +1 in the current window, or restart the window at 1. */
export async function registerIpFailure(ip: string): Promise<void> {
  const rolledOver = sql`${rateLimits.windowStart} < now() - make_interval(secs => ${IP_WINDOW_SEC})`;
  await db
    .insert(rateLimits)
    .values({ bucket: ipBucket(ip), hits: 1, windowStart: sql`now()`, updatedAt: sql`now()` })
    .onConflictDoUpdate({
      target: rateLimits.bucket,
      set: {
        hits: sql`case when ${rolledOver} then 1 else ${rateLimits.hits} + 1 end`,
        windowStart: sql`case when ${rolledOver} then now() else ${rateLimits.windowStart} end`,
        updatedAt: sql`now()`,
      },
    });
}
