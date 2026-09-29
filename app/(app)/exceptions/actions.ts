"use server";

import { revalidatePath } from "next/cache";

import { auth } from "@/lib/auth";
import { resolveException } from "@/lib/agent/exceptions";

/** Staff (VA or admin) mark an open exception resolved, with an optional note. */
export async function resolveExceptionAction(
  id: string,
  note: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const session = await auth();
  const role = session?.user?.role;
  if (!session?.user || (role !== "admin" && role !== "va")) {
    return { ok: false, message: "Only staff can resolve exceptions" };
  }
  const trimmed = note.trim().slice(0, 500);
  const done = await resolveException({
    id,
    userId: session.user.id,
    note: trimmed || null,
  });
  revalidatePath("/exceptions");
  return done ? { ok: true } : { ok: false, message: "Already resolved" };
}
