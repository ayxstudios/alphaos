"use server";

import { revalidatePath } from "next/cache";
import { and, asc, eq, sql } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { withUserContext, type RequestUser } from "@/lib/db";
import { businesses, designerBusinesses, designerProfiles, users } from "@/lib/db/schema";
import { newUserProblem, newUserRow } from "@/lib/auth/new-user";
import {
  createSignInLink,
  createTeamMember,
  resetUserPassword,
  revokeSignInLink,
  setUserActive,
} from "@/lib/team/manage";
import {
  isValidE164,
  isValidHHMM,
  isValidTimezone,
  normalizePhone,
} from "@/lib/designers/quiet-hours";
import type { PreferredChannel } from "@/lib/designers/profile";

export type ActionResult = { ok: true } | { ok: false; message: string };

const MAX_DAILY_LIMIT = 500;
const MAX_ACTIVE_ORDERS_LIMIT = 100;

async function requireStaff(): Promise<RequestUser | null> {
  const session = await auth();
  if (!session?.user) return null;
  const user = { id: session.user.id, role: session.user.role };
  if (user.role !== "admin" && user.role !== "va") return null;
  return user;
}

/**
 * Move a designer up or down the manual rank. Rewrites the whole roster to a
 * clean sequential 0..n-1 ranking after the swap, so ranks never drift or
 * collide — cheap at this scale and keeps the ordering unambiguous.
 */
export async function moveDesigner(
  userId: string,
  dir: "up" | "down",
): Promise<ActionResult> {
  const user = await requireStaff();
  if (!user) return { ok: false, message: "Not permitted" };

  await withUserContext(user, async (tx) => {
    const list = await tx
      .select({ userId: designerProfiles.userId, rank: designerProfiles.rank })
      .from(designerProfiles)
      .innerJoin(
        users,
        and(eq(users.id, designerProfiles.userId), eq(users.active, true), eq(users.role, "designer")),
      )
      .orderBy(asc(designerProfiles.rank), asc(users.name));

    const idx = list.findIndex((d) => d.userId === userId);
    if (idx === -1) return;
    const swap = dir === "up" ? idx - 1 : idx + 1;
    if (swap < 0 || swap >= list.length) return;

    [list[idx], list[swap]] = [list[swap], list[idx]];

    for (let i = 0; i < list.length; i++) {
      if (list[i].rank !== i) {
        await tx
          .update(designerProfiles)
          .set({ rank: i })
          .where(eq(designerProfiles.userId, list[i].userId));
      }
    }
  });

  // Not revalidating "/designers" here: it would force a slow server refetch of
  // the page the edit came from and clobber the optimistic UI. The page is
  // force-dynamic, so it reloads fresh on the next visit anyway. "/board" is a
  // different route (safe — just marks it stale for its next load).
  revalidatePath("/board");
  return { ok: true };
}

/** Set a designer's daily order limit (calendar-day window). */
export async function setDailyLimit(userId: string, limit: number): Promise<ActionResult> {
  const user = await requireStaff();
  if (!user) return { ok: false, message: "Not permitted" };
  if (!Number.isFinite(limit)) return { ok: false, message: "Invalid limit" };
  const clamped = Math.max(0, Math.min(MAX_DAILY_LIMIT, Math.round(limit)));

  await withUserContext(user, (tx) =>
    tx
      .update(designerProfiles)
      .set({ dailyCapacity: clamped })
      .where(eq(designerProfiles.userId, userId)),
  );
  // Not revalidating "/designers" here: it would force a slow server refetch of
  // the page the edit came from and clobber the optimistic UI. The page is
  // force-dynamic, so it reloads fresh on the next visit anyway. "/board" is a
  // different route (safe — just marks it stale for its next load).
  revalidatePath("/board");
  return { ok: true };
}

/** Replace a designer's styles. Trimmed, de-duplicated (case-insensitive). */
export async function setStyles(userId: string, raw: string[]): Promise<ActionResult> {
  const user = await requireStaff();
  if (!user) return { ok: false, message: "Not permitted" };

  const seen = new Set<string>();
  const styles: string[] = [];
  for (const s of raw) {
    const t = s.trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    styles.push(t);
  }

  await withUserContext(user, (tx) =>
    tx
      .update(designerProfiles)
      .set({ styles: styles.length ? styles : null })
      .where(eq(designerProfiles.userId, userId)),
  );
  // Not revalidating "/designers" here: it would force a slow server refetch of
  // the page the edit came from and clobber the optimistic UI. The page is
  // force-dynamic, so it reloads fresh on the next visit anyway. "/board" is a
  // different route (safe — just marks it stale for its next load).
  revalidatePath("/board");
  return { ok: true };
}

/** Set a designer's max active orders (0 = no cap on work in flight). */
export async function setMaxActiveOrders(userId: string, limit: number): Promise<ActionResult> {
  const user = await requireStaff();
  if (!user) return { ok: false, message: "Not permitted" };
  if (!Number.isFinite(limit)) return { ok: false, message: "Invalid limit" };
  const clamped = Math.max(0, Math.min(MAX_ACTIVE_ORDERS_LIMIT, Math.round(limit)));

  await withUserContext(user, (tx) =>
    tx
      .update(designerProfiles)
      .set({ maxActiveOrders: clamped })
      .where(eq(designerProfiles.userId, userId)),
  );
  revalidatePath("/board");
  return { ok: true };
}

export type ContactPatch = {
  phone: string;
  preferredChannel: PreferredChannel;
  timezone: string;
  quietStart: string;
  quietEnd: string;
};

/**
 * Admin/VA-editable contact + working-hours block: what Alpha needs to reach
 * this designer (the brief on assignment, the 24 h nudge, QC feedback) and
 * when to hold a message for quiet hours. Every field is optional (a blank
 * clears it); anything present is validated so a typo never silently breaks
 * delivery.
 */
export async function setContact(userId: string, patch: ContactPatch): Promise<ActionResult> {
  const user = await requireStaff();
  if (!user) return { ok: false, message: "Not permitted" };

  const phone = patch.phone.trim();
  if (phone && !isValidE164(normalizePhone(phone))) {
    return { ok: false, message: "Phone must be a valid international number, e.g. +6281234567890" };
  }
  const timezone = patch.timezone.trim();
  if (timezone && !isValidTimezone(timezone)) {
    return { ok: false, message: "Not a recognised timezone" };
  }
  const quietStart = patch.quietStart.trim();
  const quietEnd = patch.quietEnd.trim();
  if ((quietStart && !isValidHHMM(quietStart)) || (quietEnd && !isValidHHMM(quietEnd))) {
    return { ok: false, message: "Quiet hours must be HH:MM" };
  }
  if ((quietStart && !quietEnd) || (!quietStart && quietEnd)) {
    return { ok: false, message: "Set both a quiet-hours start and end, or leave both blank" };
  }

  await withUserContext(user, (tx) =>
    tx
      .update(designerProfiles)
      .set({
        phone: phone ? normalizePhone(phone) : null,
        preferredChannel: patch.preferredChannel === "telegram" ? "telegram" : "whatsapp",
        timezone: timezone || null,
        quietStart: quietStart || null,
        quietEnd: quietEnd || null,
      })
      .where(eq(designerProfiles.userId, userId)),
  );
  revalidatePath("/board");
  revalidatePath("/me");
  return { ok: true };
}

export type AddDesignerInput = {
  name: string;
  email: string;
  password: string;
  /** Businesses the designer can be assigned work in. Empty = the ones the caller works in. */
  businessIds?: string[];
};

export type AddDesignerResult = { ok: true; userId: string } | { ok: false; message: string };

/** A new designer starts with a small daily limit so auto-assign can reach them at all (0 = never). */
const NEW_DESIGNER_DAILY_LIMIT = 5;

/**
 * Create a designer account from the roster (admin only). Until this existed
 * the only way to mint a designer was `npm run create-user` on the owner
 * connection, which also never attached the designer to a business — so on a
 * live workspace nobody could reach the finished-portrait upload at all.
 *
 * Writes the user (role designer), a designer profile ranked last, and the
 * designer_businesses links, all in one transaction. The temporary password is
 * hashed here and never stored or logged in clear.
 */
export async function addDesigner(input: AddDesignerInput): Promise<AddDesignerResult> {
  const session = await auth();
  if (!session?.user) return { ok: false, message: "Not signed in" };
  const user: RequestUser = { id: session.user.id, role: session.user.role };
  if (user.role !== "admin") return { ok: false, message: "Only an admin can add designers" };

  const problem = newUserProblem({ name: input.name, email: input.email, password: input.password });
  if (problem) return { ok: false, message: problem };
  const values = await newUserRow({ name: input.name, email: input.email, role: "designer", password: input.password });
  const email = values.email;
  const wanted = [...new Set((input.businessIds ?? []).map((id) => id.trim()).filter(Boolean))];

  try {
    const userId = await withUserContext(user, async (tx) => {
      const [existing] = await tx.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
      if (existing) throw new Error("An account with that email already exists");

      // Only businesses the admin can see (RLS) are attachable.
      const visible = await tx.select({ id: businesses.id }).from(businesses);
      const visibleIds = new Set(visible.map((b) => b.id));
      const attach = wanted.length ? wanted.filter((id) => visibleIds.has(id)) : [...visibleIds];
      if (!attach.length) throw new Error("Choose at least one business for this designer");

      const [{ maxRank }] = await tx
        .select({ maxRank: sql<number>`coalesce(max(${designerProfiles.rank}), -1)::int` })
        .from(designerProfiles);

      const [created] = await tx
        .insert(users)
        .values(values)
        .returning({ id: users.id });
      await tx.insert(designerProfiles).values({
        userId: created.id,
        rank: Number(maxRank) + 1,
        dailyCapacity: NEW_DESIGNER_DAILY_LIMIT,
      });
      await tx.insert(designerBusinesses).values(attach.map((businessId) => ({ userId: created.id, businessId })));
      return created.id;
    });
    revalidatePath("/designers");
    revalidatePath("/board");
    return { ok: true, userId };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Could not add the designer" };
  }
}

// ---- Team (admin only): the logic lives in lib/team/manage.ts ---------------

async function sessionActor(): Promise<RequestUser | null> {
  const session = await auth();
  if (!session?.user) return null;
  return { id: session.user.id, role: session.user.role };
}

function refreshTeamViews() {
  revalidatePath("/designers");
  revalidatePath("/board");
  revalidatePath("/orders");
}

/** Add a VA or another admin with a password the admin sets (shown to them once). */
export async function addTeamMember(input: {
  name: string;
  email: string;
  password: string;
  role: "va" | "admin";
}): Promise<AddDesignerResult> {
  const res = await createTeamMember(await sessionActor(), input);
  if (res.ok) revalidatePath("/designers");
  return res;
}

/** Deactivate (or reactivate) anyone; never the last active admin. */
export async function setMemberActive(
  userId: string,
  active: boolean,
): Promise<{ ok: true; openOrders: number } | { ok: false; message: string }> {
  const res = await setUserActive(await sessionActor(), userId, active);
  if (res.ok) refreshTeamViews();
  return res;
}

/** Admin sets a new password for someone; their open sessions end. */
export async function resetMemberPassword(userId: string, password: string): Promise<ActionResult> {
  return resetUserPassword(await sessionActor(), userId, password);
}

/** Create or replace someone's private sign-in link; the URL comes back once. */
export async function makeSignInLink(
  userId: string,
): Promise<{ ok: true; url: string; expiresAt: string } | { ok: false; message: string }> {
  const res = await createSignInLink(await sessionActor(), userId);
  if (res.ok) revalidatePath("/designers");
  return res;
}

/** Stop someone's sign-in link working. */
export async function revokeMemberSignInLink(userId: string): Promise<ActionResult> {
  const res = await revokeSignInLink(await sessionActor(), userId);
  if (res.ok) revalidatePath("/designers");
  return res.ok ? { ok: true } : res;
}
