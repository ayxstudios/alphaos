"use server";

import { eq } from "drizzle-orm";

import { getSessionUser } from "@/lib/auth";
import { withUserContext } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { applyTourEvent, type TourEvent } from "@/lib/tour/state";

const EVENTS = new Set<TourEvent["type"]>(["start", "step", "complete", "dismiss", "later"]);

/**
 * Records one first-run tour event on the signed-in person's own row
 * (read-modify-write in one transaction). Never throws to the page: the tour
 * must keep working even if a save fails.
 */
export async function recordTourEvent(event: TourEvent): Promise<{ ok: boolean }> {
  const user = await getSessionUser();
  if (!user || !event || !EVENTS.has(event.type)) return { ok: false };
  if (event.type === "step" && !Number.isFinite(event.step)) return { ok: false };
  try {
    await withUserContext(user, async (tx) => {
      const [row] = await tx
        .select({ onboarding: users.onboarding })
        .from(users)
        .where(eq(users.id, user.id))
        .for("update")
        .limit(1);
      if (!row) return;
      await tx
        .update(users)
        .set({ onboarding: applyTourEvent(row.onboarding, event) })
        .where(eq(users.id, user.id));
    });
    return { ok: true };
  } catch (error) {
    console.error("recordTourEvent failed", error instanceof Error ? error.message : error);
    return { ok: false };
  }
}
