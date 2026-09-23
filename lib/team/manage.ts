import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";

import { withUserContext, type RequestUser } from "@/lib/db";
import { assignments, orders, users } from "@/lib/db/schema";
import { liveOrderWhere } from "@/lib/orders/archive";
import { hashPassword } from "@/lib/auth/password";
import { newUserProblem, newUserRow, passwordProblem } from "@/lib/auth/new-user";
import type { Role } from "@/lib/auth/config";

/**
 * Admin team management: add a VA or another admin, deactivate and reactivate
 * anyone (never the last active admin), reset a password. The server actions in
 * app/(app)/designers/actions.ts are thin wrappers around these, so the tests
 * (scripts/test-team.ts) drive exactly the code the UI runs.
 *
 * Deactivation is the "user".active flag, which every assignment path already
 * filters on (auto-assign, the 48 h reassign, the reassign pickers, the board
 * rail and default view). Nothing is deleted: orders, assignments, earnings and
 * the activity log keep pointing at the person. A deactivated person cannot
 * sign in (lib/auth/login.ts) and any session they hold is refused on the next
 * request (lib/auth/session-check.ts).
 */

export type TeamMember = {
  id: string;
  name: string;
  email: string;
  role: Role;
  active: boolean;
  /** Designers only: orders still with them (in design or awaiting QC). */
  openOrders: number;
};

export type TeamResult<T = object> = ({ ok: true } & T) | { ok: false; message: string };

class TeamError extends Error {}

function isAdmin(actor: RequestUser | null): actor is RequestUser {
  return !!actor && actor.role === "admin";
}

function fail(error: unknown, fallback: string): { ok: false; message: string } {
  if (error instanceof TeamError) return { ok: false, message: error.message };
  console.error("[team]", error);
  return { ok: false, message: fallback };
}

const WORK_IN_FLIGHT = ["in_design", "awaiting_qc"] as const;

/** Everyone who can (or could) sign in, active first, then admins, VAs, designers. */
export async function listTeam(actor: RequestUser): Promise<TeamMember[]> {
  if (!isAdmin(actor)) return [];
  return withUserContext(actor, async (tx) => {
    const rows = await tx
      .select({ id: users.id, name: users.name, email: users.email, role: users.role, active: users.active })
      .from(users)
      .orderBy(desc(users.active), asc(users.role), asc(users.name));

    const designerIds = rows.filter((r) => r.role === "designer").map((r) => r.id);
    const open = new Map<string, number>();
    if (designerIds.length) {
      for (const r of await tx
        .select({ designerId: assignments.designerId, n: sql<number>`count(*)::int` })
        .from(assignments)
        .innerJoin(orders, eq(orders.id, assignments.orderId))
        .where(
          and(
            eq(assignments.active, true),
            inArray(assignments.designerId, designerIds),
            inArray(orders.status, [...WORK_IN_FLIGHT]),
            liveOrderWhere(),
          ),
        )
        .groupBy(assignments.designerId)) {
        open.set(r.designerId, Number(r.n));
      }
    }

    return rows.map((r) => ({
      id: r.id,
      name: r.name ?? r.email,
      email: r.email,
      role: r.role,
      active: r.active,
      openOrders: open.get(r.id) ?? 0,
    }));
  });
}

/** Add a VA or another admin. Designers are added from the roster (addDesigner), which also links a business. */
export async function createTeamMember(
  actor: RequestUser | null,
  input: { name: string; email: string; password: string; role: "va" | "admin" },
): Promise<TeamResult<{ userId: string }>> {
  if (!isAdmin(actor)) return { ok: false, message: "Only an admin can add people" };
  if (input.role !== "va" && input.role !== "admin") return { ok: false, message: "Choose VA or admin" };
  const problem = newUserProblem(input);
  if (problem) return { ok: false, message: problem };

  try {
    const values = await newUserRow({ ...input, role: input.role });
    const userId = await withUserContext(actor, async (tx) => {
      const [existing] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, values.email))
        .limit(1);
      if (existing) throw new TeamError("An account with that email already exists");
      const [created] = await tx.insert(users).values(values).returning({ id: users.id });
      return created.id;
    });
    return { ok: true, userId };
  } catch (error) {
    return fail(error, "Could not add them. Try again.");
  }
}

/**
 * Deactivate or reactivate anyone. Refuses to switch off the last active admin
 * (the admin rows are locked FOR UPDATE, so two admins switching each other off
 * at the same moment cannot both win). Returns the designer's open orders so the
 * admin knows what still needs reassigning; nothing is moved automatically.
 */
export async function setUserActive(
  actor: RequestUser | null,
  targetId: string,
  active: boolean,
): Promise<TeamResult<{ openOrders: number }>> {
  if (!isAdmin(actor)) return { ok: false, message: "Only an admin can do this" };
  try {
    const openOrders = await withUserContext(actor, async (tx) => {
      const [target] = await tx
        .select({ id: users.id, role: users.role, active: users.active })
        .from(users)
        .where(eq(users.id, targetId))
        .limit(1);
      if (!target) throw new TeamError("That person was not found");

      if (!active && target.role === "admin" && target.active) {
        const otherAdmins = await tx
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.role, "admin"), eq(users.active, true), ne(users.id, target.id)))
          .for("update");
        if (otherAdmins.length === 0) {
          throw new TeamError("This is the last active admin. Add or reactivate another admin first.");
        }
      }

      if (target.active !== active) {
        await tx.update(users).set({ active }).where(eq(users.id, target.id));
      }

      if (target.role !== "designer") return 0;
      const [{ n }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(assignments)
        .innerJoin(orders, eq(orders.id, assignments.orderId))
        .where(
          and(
            eq(assignments.active, true),
            eq(assignments.designerId, target.id),
            inArray(orders.status, [...WORK_IN_FLIGHT]),
            liveOrderWhere(),
          ),
        );
      return Number(n);
    });
    return { ok: true, openOrders };
  } catch (error) {
    return fail(error, "Could not change that. Try again.");
  }
}

/** Admin sets a new password. Every session the person holds ends on its next request. */
export async function resetUserPassword(
  actor: RequestUser | null,
  targetId: string,
  password: string,
): Promise<TeamResult> {
  if (!isAdmin(actor)) return { ok: false, message: "Only an admin can reset passwords" };
  const problem = passwordProblem(password);
  if (problem) return { ok: false, message: problem };
  try {
    const passwordHash = await hashPassword(password);
    await withUserContext(actor, async (tx) => {
      const updated = await tx
        .update(users)
        .set({ passwordHash, sessionsValidAfter: new Date() })
        .where(eq(users.id, targetId))
        .returning({ id: users.id });
      if (!updated.length) throw new TeamError("That person was not found");
    });
    return { ok: true };
  } catch (error) {
    return fail(error, "Could not reset the password. Try again.");
  }
}

/**
 * End every session `targetId` signed in before now (sign-out, lib/auth/session-check.ts).
 * A person may revoke their own sessions; an admin may revoke anyone's.
 */
export async function revokeSessions(actor: RequestUser, targetId: string): Promise<void> {
  if (actor.id !== targetId && actor.role !== "admin") return;
  await withUserContext(actor, (tx) =>
    tx.update(users).set({ sessionsValidAfter: new Date() }).where(eq(users.id, targetId)),
  );
}
