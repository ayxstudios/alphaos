/**
 * Team management invariants (admin QA 2026-09-23 P1s + security QA session
 * revocation P1). Drives lib/team/manage.ts, the same code the Designers page
 * server actions call, against the seed database:
 *
 *  - an admin adds a VA: the row lands with role va, a bcrypt hash, and it signs in
 *  - only an admin can add or deactivate people
 *  - a deactivated designer is skipped by auto-assign and leaves the roster
 *  - a deactivated user cannot sign in (authenticate, which the credentials
 *    authorize() returns verbatim, gives null) and their live session is refused
 *  - a role change, a sign-out and a password reset end older sessions
 *  - the last active admin cannot be deactivated
 *
 * Everything it creates is deleted at the end; seed users it switches off are
 * switched back on.
 */
import "./load-env";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";

import { withSystemContext, type RequestUser } from "../lib/db";
import { designerBusinesses, loginAttempts, shops, users } from "../lib/db/schema";
import { authenticate } from "../lib/auth/login";
import { recheckToken } from "../lib/auth/session-check";
import { findNextEligibleDesigner } from "../lib/orders/assign";
import { getDesignerRoster } from "../lib/designers/roster";
import { createTeamMember, listTeam, resetUserPassword, revokeSessions, setUserActive } from "../lib/team/manage";

let failures = 0;
function report(name: string, pass: boolean, detail: string) {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
  console.log(`      ${detail}`);
  if (!pass) failures += 1;
}

const stamp = Date.now();
const created: { ids: string[]; emails: string[] } = { ids: [], emails: [] };
const reactivate = new Set<string>();

async function userRow(id: string) {
  const [row] = await withSystemContext((tx) =>
    tx
      .select({ role: users.role, active: users.active, passwordHash: users.passwordHash, sessionsValidAfter: users.sessionsValidAfter })
      .from(users)
      .where(eq(users.id, id)),
  );
  return row ?? null;
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
    const [shop] = await tx.select({ businessId: shops.businessId }).from(shops).limit(1);
    if (!admin || !va || !shop) throw new Error("Need the seed database (an admin, a VA and a shop)");
    return { adminId: admin.id, vaId: va.id, businessId: shop.businessId };
  });
  const admin: RequestUser = { id: ctx.adminId, role: "admin" };
  const seedVa: RequestUser = { id: ctx.vaId, role: "va" };

  try {
    // ---- 1. Add a VA -------------------------------------------------------
    const vaEmail = `team-va-${stamp}@example.test`;
    const vaPassword = "team-pass-1234";
    const added = await createTeamMember(admin, { name: "  Tess   Team VA ", email: ` ${vaEmail.toUpperCase()} `, password: vaPassword, role: "va" });
    const vaId = added.ok ? added.userId : "";
    if (added.ok) {
      created.ids.push(vaId);
      created.emails.push(vaEmail);
    }
    const vaRow = vaId ? await userRow(vaId) : null;
    report(
      "admin adds a VA: row lands with role va, active, bcrypt hash",
      added.ok && vaRow?.role === "va" && vaRow.active === true && !!vaRow.passwordHash?.startsWith("$2"),
      `ok=${added.ok} role=${vaRow?.role} active=${vaRow?.active}`,
    );
    const vaSignIn = await authenticate(vaEmail, vaPassword);
    report("the new VA signs in with the admin's password", vaSignIn?.id === vaId && vaSignIn?.role === "va", `role=${vaSignIn?.role}`);

    const team = await listTeam(admin);
    const listed = team.find((m) => m.id === vaId);
    report("the Team list shows the VA", listed?.role === "va" && listed.name === "Tess Team VA", `name=${listed?.name}`);

    const dup = await createTeamMember(admin, { name: "Dup", email: vaEmail, password: vaPassword, role: "va" });
    const byVa = await createTeamMember(seedVa, { name: "Nope", email: `team-nope-${stamp}@example.test`, password: vaPassword, role: "admin" });
    const weak = await createTeamMember(admin, { name: "Weak", email: `team-weak-${stamp}@example.test`, password: "short", role: "va" });
    report(
      "duplicate email, a VA caller and a short password are all refused",
      !dup.ok && !byVa.ok && !weak.ok,
      `dup=${dup.ok ? "ok" : dup.message} | va=${byVa.ok ? "ok" : byVa.message} | weak=${weak.ok ? "ok" : weak.message}`,
    );
    report("a VA sees no Team list", (await listTeam(seedVa)).length === 0, "listTeam(va) = []");

    // ---- 2. Inactive user cannot sign in, live session refused --------------
    const liveToken = { id: vaId, role: "va", signedInAt: Date.now() };
    report("an active session passes the per-request re-check", (await recheckToken(liveToken)) !== null, "recheckToken(active) = token");
    const off = await setUserActive(admin, vaId, false);
    const offSignIn = await authenticate(vaEmail, vaPassword);
    report(
      "deactivated user: authorize() gets null from authenticate",
      off.ok && offSignIn === null,
      `deactivate ok=${off.ok} authenticate=${offSignIn === null ? "null" : "user"}`,
    );
    report("deactivated user: their open session is refused", (await recheckToken(liveToken)) === null, "recheckToken(inactive) = null");
    const on = await setUserActive(admin, vaId, true);
    report(
      "reactivated user signs in again",
      on.ok &&
        (await authenticate(vaEmail, vaPassword))?.id === vaId &&
        (await recheckToken({ ...liveToken, signedInAt: Date.now() + 1 })) !== null,
      `reactivate ok=${on.ok}`,
    );
    report(
      "reactivation does not revive a session from before the deactivation",
      (await recheckToken(liveToken)) === null,
      "token issued before deactivation = null",
    );
    report("a VA cannot deactivate anyone", !(await setUserActive(seedVa, vaId, false)).ok, "setUserActive(va) refused");

    // ---- 3. Role change, sign-out and password reset end older sessions ------
    report("a token whose role no longer matches is refused", (await recheckToken({ ...liveToken, role: "admin" })) === null, "va row, admin token");
    const beforeReset = { id: vaId, role: "va", signedInAt: Date.now() - 1000 };
    const reset = await resetUserPassword(admin, vaId, "team-new-pass-5678");
    const afterReset = { id: vaId, role: "va", signedInAt: Date.now() + 1 };
    report(
      "password reset: old password and older sessions stop, new password works",
      reset.ok &&
        (await authenticate(vaEmail, vaPassword)) === null &&
        (await authenticate(vaEmail, "team-new-pass-5678"))?.id === vaId &&
        (await recheckToken(beforeReset)) === null &&
        (await recheckToken(afterReset)) !== null,
      `reset ok=${reset.ok}`,
    );
    const beforeSignOut = { id: vaId, role: "va", signedInAt: Date.now() - 1 };
    await revokeSessions({ id: vaId, role: "va" }, vaId);
    report("sign-out revokes a copied cookie", (await recheckToken(beforeSignOut)) === null, "token issued before sign-out = null");
    report("an unknown user id is refused", (await recheckToken({ id: randomUUID(), role: "va", signedInAt: Date.now() })) === null, "no row = null");

    // ---- 4. Inactive designer is skipped by auto-assign -----------------------
    const pick = () =>
      withSystemContext((tx) =>
        findNextEligibleDesigner(tx, { businessId: ctx.businessId, style: null, excludeDesignerId: randomUUID() }),
      );
    const top = await pick();
    if (!top) {
      report("auto-assign has an eligible designer to begin with", false, "no eligible designer in the seed business");
    } else {
      const linked = await withSystemContext((tx) =>
        tx.select({ userId: designerBusinesses.userId }).from(designerBusinesses).where(eq(designerBusinesses.businessId, ctx.businessId)),
      );
      const offDesigner = await setUserActive(admin, top, false);
      if (offDesigner.ok) reactivate.add(top);
      const next = await pick();
      const roster = await getDesignerRoster(admin);
      report(
        "deactivated designer is skipped by auto-assign and leaves the roster",
        offDesigner.ok && next !== top && !roster.some((d) => d.userId === top),
        `top=${top.slice(0, 8)} next=${next?.slice(0, 8) ?? "none"} (${linked.length} linked) inRoster=${roster.some((d) => d.userId === top)}`,
      );
      const back = await setUserActive(admin, top, true);
      if (back.ok) reactivate.delete(top);
      report("reactivated designer is picked first again", back.ok && (await pick()) === top, "rank kept");
    }

    // ---- 5. The last active admin cannot be deactivated -------------------------
    const second = await createTeamMember(admin, {
      name: "Second Admin",
      email: `team-admin-${stamp}@example.test`,
      password: "team-admin-pass-1",
      role: "admin",
    });
    if (second.ok) {
      created.ids.push(second.userId);
      created.emails.push(`team-admin-${stamp}@example.test`);
    }
    const otherAdmins = await withSystemContext((tx) =>
      tx
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.role, "admin"), eq(users.active, true))),
    );
    let othersOff = true;
    for (const a of otherAdmins) {
      if (a.id === admin.id) continue;
      const r = await setUserActive(admin, a.id, false);
      if (r.ok) {
        if (!created.ids.includes(a.id)) reactivate.add(a.id);
      } else othersOff = false;
    }
    // A hand-edited request with a non-boolean ("no") used to skip the guard.
    const lastOffString = await setUserActive(admin, admin.id, "no" as unknown as boolean);
    report(
      "a non-boolean active value is refused (no last-admin bypass)",
      !lastOffString.ok && (await userRow(admin.id))?.active === true,
      lastOffString.ok ? "was allowed" : lastOffString.message,
    );
    const lastOff = await setUserActive(admin, admin.id, false);
    const stillActive = (await userRow(admin.id))?.active === true;
    report(
      "another admin can be deactivated while one stays",
      second.ok && othersOff,
      `admins before=${otherAdmins.length}`,
    );
    report(
      "the last active admin cannot be deactivated",
      !lastOff.ok && stillActive,
      lastOff.ok ? "was allowed" : lastOff.message,
    );
  } finally {
    for (const id of reactivate) {
      await withSystemContext((tx) => tx.update(users).set({ active: true }).where(eq(users.id, id)));
    }
    if (created.ids.length) {
      await withSystemContext((tx) => tx.delete(users).where(inArray(users.id, created.ids)));
    }
    const emails = [...created.emails, `team-nope-${stamp}@example.test`, `team-weak-${stamp}@example.test`];
    await withSystemContext((tx) => tx.delete(loginAttempts).where(inArray(loginAttempts.email, emails)));
  }

  console.log(failures === 0 ? `\nAll checks passed.` : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
