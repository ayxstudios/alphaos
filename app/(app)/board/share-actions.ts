"use server";

import { revalidatePath } from "next/cache";

import { auth } from "@/lib/auth";
import type { RequestUser } from "@/lib/db";
import { addHelper, listHelpers, recreateHelperLink, removeHelper, type Helper } from "@/lib/team/helpers";

/**
 * Thin actions behind the board's "Share your board" panel: a designer adds a
 * helper, removes them, or makes them a new sign-in link. Authorization lives
 * in lib/team/helpers.ts; the actor always comes from the session.
 */

type Failure = { ok: false; message: string };

// Server actions take hand-edited JSON: anything that is not a sane string is refused.
function cleanName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim().replace(/\s+/g, " ");
  return name.length >= 2 && name.length <= 80 ? name : null;
}

function cleanId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const id = raw.trim();
  return id.length >= 1 && id.length <= 100 ? id : null;
}

async function actor(): Promise<RequestUser | null> {
  const session = await auth();
  if (!session?.user) return null;
  return { id: session.user.id, role: session.user.role };
}

export async function listMyHelpers(): Promise<Helper[]> {
  return listHelpers(await actor());
}

export async function addHelperAction(
  name: string,
): Promise<{ ok: true; helperId: string; url: string; expiresAt: string } | Failure> {
  const clean = cleanName(name);
  if (!clean) return { ok: false, message: "Enter their name" };
  const result = await addHelper(await actor(), clean);
  if (result.ok) revalidatePath("/board");
  return result;
}

export async function removeHelperAction(helperId: string): Promise<{ ok: true } | Failure> {
  const id = cleanId(helperId);
  if (!id) return { ok: false, message: "That helper was not found" };
  const result = await removeHelper(await actor(), id);
  if (result.ok) revalidatePath("/board");
  return result;
}

export async function recreateHelperLinkAction(
  helperId: string,
): Promise<{ ok: true; url: string; expiresAt: string } | Failure> {
  const id = cleanId(helperId);
  if (!id) return { ok: false, message: "That helper was not found" };
  const result = await recreateHelperLink(await actor(), id);
  if (result.ok) revalidatePath("/board");
  return result;
}
