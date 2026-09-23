import { cache } from "react";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import type { Role } from "./config";

/**
 * Per-request session re-check (security QA 2026-09-23, P1 revocation).
 *
 * Sessions are JWTs, so without this a deactivated user, a user whose role
 * changed, or a cookie copied before sign-out kept working for up to 30 days.
 * The Node `jwt` callback (lib/auth/index.ts) calls `recheckToken` on every
 * `auth()`: one indexed read of one "user" row by id, deduplicated per render
 * by React `cache()` (layout + page + actions share it). The edge middleware
 * keeps decoding the cookie without the DB; the page's own `auth()` is what
 * refuses a revoked session (null session -> the app layout sends /login).
 *
 * Uses the raw `db` handle deliberately, like `authenticate` in ./login.ts:
 * this runs inside Auth.js before any user context exists, against the
 * "user" table, which has no RLS (an Auth.js table).
 */

export type SessionRow = {
  active: boolean;
  role: Role;
  sessionsValidAfter: Date | null;
};

export type SessionToken = {
  id?: unknown;
  role?: unknown;
  signedInAt?: unknown;
};

/** Pure rule: may this token keep its session, given the user's current row? */
export function isSessionCurrent(row: SessionRow | null, token: SessionToken): boolean {
  if (!row) return false; // user deleted
  if (!row.active) return false; // deactivated by an admin
  if (row.role !== token.role) return false; // role changed: sign in again for the new role
  if (row.sessionsValidAfter) {
    const signedInAt = typeof token.signedInAt === "number" ? token.signedInAt : 0;
    if (signedInAt < row.sessionsValidAfter.getTime()) return false; // signed out or password reset since
  }
  return true;
}

/** One row by primary key. `cache()` makes repeat calls in one render free. */
export const loadSessionRow = cache(async (userId: string): Promise<SessionRow | null> => {
  const [row] = await db
    .select({
      active: users.active,
      role: users.role,
      sessionsValidAfter: users.sessionsValidAfter,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row ?? null;
});

/**
 * The token when the session is still good, else null (Auth.js then treats the
 * request as signed out and clears the cookie where it can). A database error
 * keeps the token: the page's own queries fail loudly anyway, and a DB blip
 * must not sign every user out.
 */
export async function recheckToken<T extends object>(token: T): Promise<T | null> {
  const t = token as SessionToken;
  if (typeof t.id !== "string" || !t.id) return null;
  let row: SessionRow | null;
  try {
    row = await loadSessionRow(t.id);
  } catch (error) {
    console.error("[auth] session re-check failed, keeping the session", error);
    return token;
  }
  return isSessionCurrent(row, t) ? token : null;
}
