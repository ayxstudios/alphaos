"use server";

import { revalidatePath } from "next/cache";
import { and, asc, eq } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { withUserContext, type RequestUser } from "@/lib/db";
import { designerProfiles, users } from "@/lib/db/schema";

export type ActionResult = { ok: true } | { ok: false; message: string };

const MAX_DAILY_LIMIT = 500;

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

  revalidatePath("/designers");
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
  revalidatePath("/designers");
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
  revalidatePath("/designers");
  revalidatePath("/board");
  return { ok: true };
}
