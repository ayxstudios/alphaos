"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";

import { auth, signOut } from "@/lib/auth";
import { revokeSessions } from "@/lib/team/manage";
import { BUSINESS_COOKIE } from "@/lib/shell/constants";

/** Persist the active business selection (see BUSINESS_COOKIE / loadShellData). */
export async function setBusiness(businessId: string): Promise<void> {
  const store = await cookies();
  store.set(BUSINESS_COOKIE, businessId, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 365,
  });
  revalidatePath("/", "layout");
}

/**
 * Sign out, and make it real: every session this person signed in before now
 * is refused from the next request (lib/auth/session-check.ts), so a copied
 * cookie dies too. This signs them out on their other devices as well.
 */
export async function signOutAction(): Promise<void> {
  const session = await auth();
  if (session?.user?.id) {
    try {
      await revokeSessions({ id: session.user.id, role: session.user.role }, session.user.id);
    } catch (error) {
      // Never block the sign-out itself; the cookie is still cleared below.
      console.error("[auth] could not revoke sessions on sign-out", error);
    }
  }
  await signOut({ redirectTo: "/login" });
}
