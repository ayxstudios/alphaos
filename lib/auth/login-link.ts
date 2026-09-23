import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";

import { db, type Tx } from "@/lib/db";
import { loginLinks, users } from "@/lib/db/schema";
import { AccountLockedError, IP_MAX_FAILED, ipFailures, registerIpFailure, type AuthedUser } from "./login";

/**
 * Per-person sign-in links (docs/LOGIN-LINKS.md). The base /login keeps asking
 * for a password; each person can also hold ONE private link,
 * `<app>/auth/link/<token>`, that signs them in with no typing.
 *
 * A link is a credential: anyone holding it signs in as that person. So:
 *  - the token is 32 random bytes (base64url, 43 characters) and only its
 *    sha256 is stored (login_links.token_hash), the clear token is shown once;
 *  - it expires (90 days by default) and is reusable until then;
 *  - minting a new one revokes the previous one (one active link per user, also
 *    a partial unique index in migration 0039);
 *  - deactivating the person or resetting their password revokes it
 *    (lib/team/manage.ts), and so does "Revoke link" / scripts/login-link.ts.
 *
 * login_links has NO row-level security (like login_attempts): the "link"
 * Credentials provider reads it before any session exists, so
 * `authenticateLink` uses the raw `db` handle deliberately, exactly like
 * `authenticate` in ./login.ts. Admin mint/revoke run inside the caller's
 * transaction (`withUserContext` for the admin in lib/team/manage.ts).
 */

export const LINK_DEFAULT_DAYS = 90;
export const LINK_MAX_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 32 random bytes in base64url = exactly 43 URL-safe characters. */
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export function newLinkToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashLinkToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function isWellFormedLinkToken(token: unknown): token is string {
  return typeof token === "string" && TOKEN_RE.test(token);
}

/** Relative path of a link; `loginLinkUrl` adds the app origin. */
export function loginLinkPath(token: string): string {
  return `/auth/link/${token}`;
}

/**
 * The full URL from NEXT_PUBLIC_APP_URL. Without it (never in a deployed
 * environment) the relative path is returned and the admin panel prefixes the
 * browser's own origin.
 */
export function loginLinkUrl(token: string, base = process.env.NEXT_PUBLIC_APP_URL): string {
  const origin = (base ?? "").trim().replace(/\/+$/, "");
  return `${origin}${loginLinkPath(token)}`;
}

/** Days clamped to 1..365; anything unreadable falls back to 90. */
export function linkDays(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return LINK_DEFAULT_DAYS;
  return Math.min(LINK_MAX_DAYS, Math.max(1, Math.round(n)));
}

export type MintedLink = { token: string; expiresAt: Date };

/**
 * Revoke the person's live link (if any) and insert a new one, in the caller's
 * transaction so the swap is atomic. The clear token is returned once and never
 * stored. The caller checks the person exists and is active.
 */
export async function mintLoginLinkTx(
  tx: Tx,
  input: { userId: string; createdBy: string | null; days?: number; now?: Date },
): Promise<MintedLink> {
  const now = input.now ?? new Date();
  const days = linkDays(input.days ?? LINK_DEFAULT_DAYS);
  await revokeLoginLinksTx(tx, input.userId, now);
  const token = newLinkToken();
  const expiresAt = new Date(now.getTime() + days * DAY_MS);
  await tx.insert(loginLinks).values({
    userId: input.userId,
    tokenHash: hashLinkToken(token),
    createdBy: input.createdBy,
    createdAt: now,
    expiresAt,
  });
  return { token, expiresAt };
}

/** Revoke every live link the person holds. Returns how many were revoked. */
export async function revokeLoginLinksTx(tx: Tx, userId: string, now = new Date()): Promise<number> {
  const revoked = await tx
    .update(loginLinks)
    .set({ revokedAt: now })
    .where(and(eq(loginLinks.userId, userId), isNull(loginLinks.revokedAt)))
    .returning({ id: loginLinks.id });
  return revoked.length;
}

/**
 * The "link" provider's check. Returns the same user shape as the password
 * provider (so the JWT id/role/signedInAt and the per-request re-check work
 * unchanged), null when the link does not work (unknown, revoked, expired,
 * deactivated person), or throws AccountLockedError when this IP is over the
 * shared per-IP failure limit. A failed link counts as a failed sign-in for the
 * per-IP limit, so guessing links is throttled like guessing passwords.
 */
export async function authenticateLink(
  rawToken: unknown,
  ip: string | null = null,
  now = new Date(),
): Promise<AuthedUser | null> {
  if (ip && (await ipFailures(ip)) >= IP_MAX_FAILED) {
    throw new AccountLockedError();
  }

  const token = typeof rawToken === "string" ? rawToken.trim() : "";
  let user: AuthedUser | null = null;
  let linkId: string | null = null;

  if (isWellFormedLinkToken(token)) {
    const [row] = await db
      .select({
        linkId: loginLinks.id,
        expiresAt: loginLinks.expiresAt,
        revokedAt: loginLinks.revokedAt,
        id: users.id,
        email: users.email,
        name: users.name,
        role: users.role,
        image: users.image,
        active: users.active,
      })
      .from(loginLinks)
      .innerJoin(users, eq(users.id, loginLinks.userId))
      .where(eq(loginLinks.tokenHash, hashLinkToken(token)))
      .limit(1);
    if (row && !row.revokedAt && row.expiresAt > now && row.active) {
      linkId = row.linkId;
      user = { id: row.id, email: row.email, name: row.name, role: row.role, image: row.image };
    }
  }

  if (!user || !linkId) {
    if (ip) await registerIpFailure(ip);
    return null;
  }

  await db.update(loginLinks).set({ lastUsedAt: now }).where(eq(loginLinks.id, linkId));
  return user;
}

export type LinkStatus = { expiresAt: Date; lastUsedAt: Date | null; createdAt: Date };
