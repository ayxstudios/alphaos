import { CredentialsSignin } from "next-auth";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { users, loginAttempts } from "@/lib/db/schema";
import { verifyPassword } from "./password";
import type { Role } from "./config";

const MAX_FAILED = 10;
const LOCK_MS = 15 * 60 * 1000; // 15 minutes

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
 * against tables with no RLS (`user`, `login_attempts`). Returns the user on
 * success, `null` on bad credentials, and throws AccountLockedError when the
 * email is locked out (10 failures → 15-minute lock).
 */
export async function authenticate(
  rawEmail: string,
  password: string,
): Promise<AuthedUser | null> {
  const email = rawEmail.trim().toLowerCase();
  const now = new Date();

  const [attempt] = await db
    .select()
    .from(loginAttempts)
    .where(eq(loginAttempts.email, email));

  if (attempt?.lockedUntil && attempt.lockedUntil > now) {
    throw new AccountLockedError();
  }

  const [user] = await db.select().from(users).where(eq(users.email, email));
  const ok =
    !!user?.passwordHash &&
    user.active &&
    (await verifyPassword(password, user.passwordHash));

  if (!ok) {
    await registerFailure(email, attempt?.failedCount ?? 0, now);
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
