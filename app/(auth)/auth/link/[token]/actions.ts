"use server";

import { AuthError, CredentialsSignin } from "next-auth";

import { signIn } from "@/lib/auth";

export type LinkResult = { ok: false; locked: boolean };

/**
 * Server-side fallback for the link page. The client-side signIn() needs two
 * extra fetches (csrf + providers) that some in-app browsers and content
 * blockers break; a server action does the same check in one request, exactly
 * like the password form. On success it throws NEXT_REDIRECT (re-thrown here).
 */
export async function linkSignInAction(token: string): Promise<LinkResult> {
  try {
    await signIn("link", { token: String(token ?? ""), redirectTo: "/dashboard" });
  } catch (err) {
    if (err instanceof CredentialsSignin) return { ok: false, locked: err.code === "locked" };
    if (err instanceof AuthError) return { ok: false, locked: false };
    throw err;
  }
  return { ok: false, locked: false };
}
