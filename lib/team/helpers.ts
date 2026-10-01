import { and, asc, desc, eq, gt, inArray, isNull } from "drizzle-orm";

import { withUserContext, type RequestUser, type Tx } from "@/lib/db";
import { loginLinks, users } from "@/lib/db/schema";
import { normalizeName } from "@/lib/auth/new-user";
import { LINK_DEFAULT_DAYS, loginLinkUrl, mintLoginLinkTx, revokeLoginLinksTx } from "@/lib/auth/login-link";
import type { TeamResult } from "@/lib/team/manage";

/**
 * A designer's helper: a team member who works the designer's board (migration
 * 0042) and can never see pay. The designer adds and removes their own helpers;
 * an admin may act for any designer by passing `designerId`.
 *
 * A helper has no password and no real email: they sign in only through a
 * private link (90 days, one live link per person, lib/auth/login-link.ts). The
 * email column is NOT NULL UNIQUE, so each helper gets a unique placeholder on
 * a reserved .invalid domain. Removal deactivates (nothing is deleted: the
 * activity log keeps pointing at them), revokes their link and ends every
 * session they hold.
 *
 * Helpers are never listed by listTeam (lib/team/manage.ts) or the designer
 * roster; they appear only here.
 */

export type Helper = {
  id: string;
  name: string;
  active: boolean;
  /** Their live sign-in link (unrevoked, unexpired), or null. ISO timestamps. */
  link: { expiresAt: string; lastUsedAt: string | null } | null;
};

class HelperError extends Error {}

function fail(error: unknown, fallback: string): { ok: false; message: string } {
  if (error instanceof HelperError) return { ok: false, message: error.message };
  console.error("[helpers]", error);
  return { ok: false, message: fallback };
}

/** The designer whose helpers these are: the designer themself, or the named designer for an admin. */
function principalFor(actor: RequestUser | null, designerId?: string): string | null {
  if (!actor) return null;
  if (actor.role === "designer") return actor.id;
  if (actor.role === "admin" && designerId) return designerId;
  return null;
}

/** Load a helper the actor may manage: role helper, helper_for = the principal. */
async function loadOwnHelper(tx: Tx, principalId: string, helperId: string) {
  const [helper] = await tx
    .select({ id: users.id, role: users.role, active: users.active, helperFor: users.helperFor })
    .from(users)
    .where(eq(users.id, helperId))
    .limit(1);
  if (!helper || helper.role !== "helper" || helper.helperFor !== principalId) {
    throw new HelperError("That helper was not found");
  }
  return helper;
}

/** The designer must exist, be active and be a designer (an admin may name anyone). */
async function assertDesigner(tx: Tx, designerId: string) {
  const [d] = await tx
    .select({ role: users.role, active: users.active })
    .from(users)
    .where(eq(users.id, designerId))
    .limit(1);
  if (!d || d.role !== "designer" || !d.active) throw new HelperError("That designer was not found");
}

export async function listHelpers(actor: RequestUser | null, designerId?: string): Promise<Helper[]> {
  const principalId = principalFor(actor, designerId);
  if (!actor || !principalId) return [];
  return withUserContext(actor, async (tx) => {
    const rows = await tx
      .select({ id: users.id, name: users.name, active: users.active })
      .from(users)
      .where(and(eq(users.role, "helper"), eq(users.helperFor, principalId)))
      .orderBy(desc(users.active), asc(users.name));
    if (!rows.length) return [];
    const links = new Map<string, Helper["link"]>();
    for (const l of await tx
      .select({ userId: loginLinks.userId, expiresAt: loginLinks.expiresAt, lastUsedAt: loginLinks.lastUsedAt })
      .from(loginLinks)
      .where(
        and(
          inArray(loginLinks.userId, rows.map((r) => r.id)),
          isNull(loginLinks.revokedAt),
          gt(loginLinks.expiresAt, new Date()),
        ),
      )) {
      links.set(l.userId, { expiresAt: l.expiresAt.toISOString(), lastUsedAt: l.lastUsedAt?.toISOString() ?? null });
    }
    return rows.map((r) => ({ id: r.id, name: r.name ?? "Helper", active: r.active, link: links.get(r.id) ?? null }));
  });
}

/** Create an active helper for the designer and mint their 90-day sign-in link. The URL is shown once. */
export async function addHelper(
  actor: RequestUser | null,
  name: string,
  designerId?: string,
): Promise<TeamResult<{ helperId: string; url: string; expiresAt: string }>> {
  const principalId = principalFor(actor, designerId);
  if (!actor || !principalId) return { ok: false, message: "Only a designer can add a helper" };
  const clean = normalizeName(name);
  if (clean.length < 2 || clean.length > 80) return { ok: false, message: "Enter their name" };
  try {
    const out = await withUserContext(actor, async (tx) => {
      if (actor.role === "admin") await assertDesigner(tx, principalId);
      const id = crypto.randomUUID();
      await tx.insert(users).values({
        id,
        name: clean,
        email: `helper-${id}@helpers.invalid`,
        role: "helper",
        helperFor: principalId,
        active: true,
      });
      const minted = await mintLoginLinkTx(tx, { userId: id, createdBy: actor.id, days: LINK_DEFAULT_DAYS });
      return { id, minted };
    });
    return { ok: true, helperId: out.id, url: loginLinkUrl(out.minted.token), expiresAt: out.minted.expiresAt.toISOString() };
  } catch (error) {
    return fail(error, "Could not add the helper. Try again.");
  }
}

/** Deactivate the helper, revoke their link and end their sessions. */
export async function removeHelper(
  actor: RequestUser | null,
  helperId: string,
  designerId?: string,
): Promise<TeamResult> {
  const principalId = principalFor(actor, designerId);
  if (!actor || !principalId) return { ok: false, message: "Not permitted" };
  try {
    await withUserContext(actor, async (tx) => {
      const helper = await loadOwnHelper(tx, principalId, helperId);
      await tx.update(users).set({ active: false, sessionsValidAfter: new Date() }).where(eq(users.id, helper.id));
      await revokeLoginLinksTx(tx, helper.id);
    });
    return { ok: true };
  } catch (error) {
    return fail(error, "Could not remove the helper. Try again.");
  }
}

/** Replace the helper's link (the old one stops working). The URL is shown once. */
export async function recreateHelperLink(
  actor: RequestUser | null,
  helperId: string,
  designerId?: string,
): Promise<TeamResult<{ url: string; expiresAt: string }>> {
  const principalId = principalFor(actor, designerId);
  if (!actor || !principalId) return { ok: false, message: "Not permitted" };
  try {
    const minted = await withUserContext(actor, async (tx) => {
      const helper = await loadOwnHelper(tx, principalId, helperId);
      if (!helper.active) throw new HelperError("That helper was removed");
      return mintLoginLinkTx(tx, { userId: helper.id, createdBy: actor.id, days: LINK_DEFAULT_DAYS });
    });
    return { ok: true, url: loginLinkUrl(minted.token), expiresAt: minted.expiresAt.toISOString() };
  } catch (error) {
    return fail(error, "Could not make the link. Try again.");
  }
}
