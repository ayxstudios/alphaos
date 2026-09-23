/**
 * Per-person sign-in links (lib/auth/login-link.ts, docs/LOGIN-LINKS.md).
 * Drives the same code the "link" Credentials provider's authorize() and the
 * Team panel's server actions call, against the seed database:
 *
 *  - an admin mints a link: full URL once, 43-character base64url token, only
 *    the sha256 stored, 90-day expiry; a VA cannot mint
 *  - authorize signs in with the same user shape as the password provider,
 *    stamps last_used_at, and the session passes the per-request re-check
 *  - reuse works; expired, revoked and malformed tokens are refused
 *  - a deactivated person is refused, and deactivating revokes the link
 *  - minting again revokes the old link (one active link per person)
 *  - a password reset revokes the link
 *  - the per-IP login limit applies to link attempts too
 *
 * Everything it creates is deleted at the end.
 */
import "./load-env";
import { and, eq, inArray, isNull } from "drizzle-orm";

import { withSystemContext, type RequestUser } from "../lib/db";
import { loginAttempts, loginLinks, rateLimits, users } from "../lib/db/schema";
import { authConfig } from "../lib/auth/config";
import { AccountLockedError, IP_MAX_FAILED, authenticate } from "../lib/auth/login";
import { authenticateLink, hashLinkToken, loginLinkUrl } from "../lib/auth/login-link";
import { recheckToken } from "../lib/auth/session-check";
import {
  createSignInLink,
  createTeamMember,
  listTeam,
  resetUserPassword,
  revokeSignInLink,
  setUserActive,
} from "../lib/team/manage";

let failures = 0;
function report(name: string, pass: boolean, detail: string) {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
  console.log(`      ${detail}`);
  if (!pass) failures += 1;
}

const stamp = Date.now();
const created: { ids: string[]; emails: string[] } = { ids: [], emails: [] };
const IP = `203.0.113.${(stamp % 200) + 20}`;

const tokenOf = (url: string) => url.split("/auth/link/")[1] ?? "";

async function linkRows(userId: string) {
  return withSystemContext((tx) =>
    tx
      .select({ tokenHash: loginLinks.tokenHash, revokedAt: loginLinks.revokedAt, lastUsedAt: loginLinks.lastUsedAt, expiresAt: loginLinks.expiresAt, createdBy: loginLinks.createdBy })
      .from(loginLinks)
      .where(eq(loginLinks.userId, userId)),
  );
}

async function outcome(p: Promise<unknown>): Promise<"user" | "null" | "locked" | "error"> {
  try {
    return (await p) ? "user" : "null";
  } catch (error) {
    return error instanceof AccountLockedError ? "locked" : "error";
  }
}

async function addPerson(admin: RequestUser, label: string, password: string) {
  const email = `link-${label}-${stamp}@example.test`;
  const res = await createTeamMember(admin, { name: `Link ${label}`, email, password, role: "va" });
  if (!res.ok) throw new Error(`could not create ${email}: ${res.message}`);
  created.ids.push(res.userId);
  created.emails.push(email);
  return { id: res.userId, email };
}

async function mint(admin: RequestUser, userId: string) {
  const res = await createSignInLink(admin, userId);
  if (!res.ok) throw new Error(`mint failed: ${res.message}`);
  return res;
}

async function main() {
  const ctx = await withSystemContext(async (tx) => {
    const [admin] = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.role, "admin"), eq(users.active, true)))
      .limit(1);
    const [va] = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.role, "va"), eq(users.active, true)))
      .limit(1);
    if (!admin || !va) throw new Error("Need the seed database (an admin and a VA)");
    return { adminId: admin.id, vaId: va.id };
  });
  const admin: RequestUser = { id: ctx.adminId, role: "admin" };
  const seedVa: RequestUser = { id: ctx.vaId, role: "va" };
  const password = "link-pass-1234";

  try {
    const person = await addPerson(admin, "main", password);

    // ---- 1. Mint -----------------------------------------------------------
    const t0 = Date.now();
    const first = await mint(admin, person.id);
    const token = tokenOf(first.url);
    const rows = await linkRows(person.id);
    const days = (new Date(first.expiresAt).getTime() - t0) / 86_400_000;
    report(
      "an admin mints a link: full URL once, 43-char base64url token, only the sha256 stored",
      first.url === loginLinkUrl(token) &&
        /^[A-Za-z0-9_-]{43}$/.test(token) &&
        rows.length === 1 &&
        rows[0].tokenHash === hashLinkToken(token) &&
        rows[0].tokenHash !== token &&
        rows[0].createdBy === admin.id &&
        !rows[0].revokedAt,
      `url=${first.url.replace(token, "<token>")}, rows=${rows.length}, hash stored=${rows[0]?.tokenHash === hashLinkToken(token)}`,
    );
    report("the link expires in 90 days", Math.abs(days - 90) < 0.01, `expires in ${days.toFixed(3)} days`);
    report(
      "the full URL uses NEXT_PUBLIC_APP_URL",
      !!process.env.NEXT_PUBLIC_APP_URL && first.url.startsWith(`${process.env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "")}/auth/link/`),
      `NEXT_PUBLIC_APP_URL=${process.env.NEXT_PUBLIC_APP_URL ?? "(unset)"}`,
    );
    const vaTry = await createSignInLink(seedVa, person.id);
    report("a VA cannot mint a link", !vaTry.ok, `result: ${JSON.stringify(vaTry)}`);
    const vaRevoke = await revokeSignInLink(seedVa, person.id);
    report("a VA cannot revoke a link", !vaRevoke.ok, `result: ${JSON.stringify(vaRevoke)}`);

    // ---- 2. Sign in (authorize) --------------------------------------------
    const viaLink = await authenticateLink(token, IP);
    const viaPassword = await authenticate(person.email, password, null);
    report(
      "authorize(link) returns the same user shape as the password provider",
      !!viaLink && JSON.stringify(viaLink) === JSON.stringify(viaPassword),
      `link=${JSON.stringify(viaLink)}`,
    );
    const afterUse = await linkRows(person.id);
    report("a sign-in stamps last_used_at", !!afterUse[0]?.lastUsedAt, `last_used_at=${afterUse[0]?.lastUsedAt?.toISOString()}`);
    // The JWT callback stamps signedInAt; the per-request re-check keeps the session.
    const jwt = authConfig.callbacks.jwt({ token: {}, user: viaLink! } as never);
    const kept = await recheckToken(jwt);
    report(
      "the link session carries id/role/signedInAt and passes the per-request re-check",
      !!kept && jwt.id === person.id && jwt.role === "va" && typeof jwt.signedInAt === "number",
      `jwt=${JSON.stringify({ id: jwt.id === person.id, role: jwt.role, signedInAt: typeof jwt.signedInAt })}`,
    );
    const team = await listTeam(admin);
    const listed = team.find((m) => m.id === person.id);
    report(
      "the Team panel lists the active link with its expiry",
      !!listed?.link && listed.link.expiresAt === first.expiresAt,
      `link=${JSON.stringify(listed?.link)}`,
    );

    // ---- 3. Reuse ------------------------------------------------------------
    report("reuse works (the link is not one-shot)", (await outcome(authenticateLink(token, IP))) === "user", "second sign-in = user");

    // ---- 4. Malformed / unknown ----------------------------------------------
    const unknown = "A".repeat(43);
    report(
      "unknown and malformed tokens are refused",
      (await outcome(authenticateLink(unknown, null))) === "null" &&
        (await outcome(authenticateLink("short", null))) === "null" &&
        (await outcome(authenticateLink(undefined, null))) === "null" &&
        (await outcome(authenticateLink(token.slice(0, 42) + "!", null))) === "null",
      "all null",
    );

    // ---- 5. Expired ----------------------------------------------------------
    await withSystemContext((tx) =>
      tx.update(loginLinks).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(loginLinks.tokenHash, hashLinkToken(token))),
    );
    report("an expired link is refused", (await outcome(authenticateLink(token, null))) === "null", "authorize = null");
    const teamExpired = (await listTeam(admin)).find((m) => m.id === person.id);
    report("an expired link is not listed as active", teamExpired?.link === null, `link=${JSON.stringify(teamExpired?.link)}`);

    // ---- 6. Minting again revokes the old one --------------------------------
    const second = await mint(admin, person.id);
    const secondToken = tokenOf(second.url);
    await withSystemContext((tx) =>
      tx.update(loginLinks).set({ expiresAt: new Date(Date.now() + 86_400_000) }).where(eq(loginLinks.tokenHash, hashLinkToken(token))),
    );
    const third = await mint(admin, person.id);
    const thirdToken = tokenOf(third.url);
    const live = (await linkRows(person.id)).filter((r) => !r.revokedAt);
    report(
      "minting again revokes the old link (one active link per person)",
      (await outcome(authenticateLink(secondToken, null))) === "null" &&
        (await outcome(authenticateLink(token, null))) === "null" &&
        (await outcome(authenticateLink(thirdToken, null))) === "user" &&
        live.length === 1 &&
        live[0].tokenHash === hashLinkToken(thirdToken),
      `live links=${live.length}`,
    );

    // ---- 7. Revoked ----------------------------------------------------------
    const revoked = await revokeSignInLink(admin, person.id);
    report(
      "a revoked link is refused",
      revoked.ok && revoked.revoked === 1 && (await outcome(authenticateLink(thirdToken, null))) === "null",
      `revoke=${JSON.stringify(revoked)}`,
    );
    report(
      "revoking keeps the password working",
      (await outcome(authenticate(person.email, password, null))) === "user",
      "password sign-in = user",
    );

    // ---- 8. Password reset revokes ------------------------------------------
    const beforeReset = await mint(admin, person.id);
    const reset = await resetUserPassword(admin, person.id, "link-pass-5678");
    report(
      "a password reset revokes the link",
      reset.ok && (await outcome(authenticateLink(tokenOf(beforeReset.url), null))) === "null" &&
        (await linkRows(person.id)).every((r) => !!r.revokedAt),
      `reset=${JSON.stringify(reset)}`,
    );

    // ---- 9. Deactivated ------------------------------------------------------
    const beforeOff = await mint(admin, person.id);
    const offToken = tokenOf(beforeOff.url);
    // The user check alone (link row still live): flip the flag directly.
    await withSystemContext((tx) => tx.update(users).set({ active: false }).where(eq(users.id, person.id)));
    report("a deactivated person's link is refused", (await outcome(authenticateLink(offToken, null))) === "null", "authorize = null");
    await withSystemContext((tx) => tx.update(users).set({ active: true }).where(eq(users.id, person.id)));
    report("the same link works again once active (row untouched)", (await outcome(authenticateLink(offToken, null))) === "user", "authorize = user");
    const off = await setUserActive(admin, person.id, false);
    const offRows = await withSystemContext((tx) =>
      tx.select({ id: loginLinks.id }).from(loginLinks).where(and(eq(loginLinks.userId, person.id), isNull(loginLinks.revokedAt))),
    );
    report(
      "deactivating (Team panel) revokes the link",
      off.ok && offRows.length === 0,
      `deactivate=${JSON.stringify(off)}, live links=${offRows.length}`,
    );
    await setUserActive(admin, person.id, true);
    report(
      "reactivating does not bring the old link back",
      (await outcome(authenticateLink(offToken, null))) === "null",
      "authorize = null",
    );
    await setUserActive(admin, person.id, false);
    const noLinkForInactive = await createSignInLink(admin, person.id);
    report("no link can be made for a deactivated person", !noLinkForInactive.ok, `result: ${JSON.stringify(noLinkForInactive)}`);
    await setUserActive(admin, person.id, true);

    // ---- 10. Per-IP limit ----------------------------------------------------
    const limited = await mint(admin, person.id);
    const limitedToken = tokenOf(limited.url);
    await withSystemContext((tx) => tx.delete(rateLimits).where(eq(rateLimits.bucket, `login-ip:${IP}`)));
    await authenticateLink(unknown, IP);
    const [bucket] = await withSystemContext((tx) =>
      tx.select({ hits: rateLimits.hits }).from(rateLimits).where(eq(rateLimits.bucket, `login-ip:${IP}`)),
    );
    report("a bad link counts toward the per-IP login limit", bucket?.hits === 1, `hits=${bucket?.hits}`);
    await withSystemContext((tx) =>
      tx.update(rateLimits).set({ hits: IP_MAX_FAILED }).where(eq(rateLimits.bucket, `login-ip:${IP}`)),
    );
    report(
      "an IP over the limit is locked out of links too (even a good one)",
      (await outcome(authenticateLink(limitedToken, IP))) === "locked" &&
        (await outcome(authenticateLink(limitedToken, null))) === "user",
      "same IP = locked, no IP = user",
    );
  } finally {
    await withSystemContext((tx) => tx.delete(rateLimits).where(eq(rateLimits.bucket, `login-ip:${IP}`)));
    if (created.ids.length) {
      await withSystemContext((tx) => tx.delete(loginLinks).where(inArray(loginLinks.userId, created.ids)));
      await withSystemContext((tx) => tx.delete(users).where(inArray(users.id, created.ids)));
    }
    if (created.emails.length) {
      await withSystemContext((tx) => tx.delete(loginAttempts).where(inArray(loginAttempts.email, created.emails)));
    }
  }

  console.log(failures === 0 ? `\nAll checks passed.` : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
