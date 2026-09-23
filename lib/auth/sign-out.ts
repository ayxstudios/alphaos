import type { Role } from "./config";
import { revokeSessions } from "@/lib/team/manage";

const ROLES = new Set<string>(["admin", "va", "designer"]);

/**
 * Auth.js `events.signOut` (lib/auth/index.ts). The app's own sign-out
 * (`signOutAction`) revokes the person's sessions before clearing the cookie,
 * but the built-in `POST /api/auth/signout` only cleared the cookie, so a copy
 * of it kept working. This runs on EVERY Auth.js sign-out: it stamps
 * `sessions_valid_after`, so any copy of the token is refused by the
 * per-request re-check (./session-check.ts). Never throws: a failed revoke
 * must not block the sign-out itself.
 */
export async function revokeOnSignOut(message: { token?: unknown } | { session?: unknown }): Promise<void> {
  const token = "token" in message ? (message.token as { id?: unknown; role?: unknown } | null) : null;
  if (!token || typeof token.id !== "string" || !token.id) return;
  if (typeof token.role !== "string" || !ROLES.has(token.role)) return;
  try {
    await revokeSessions({ id: token.id, role: token.role as Role }, token.id);
  } catch (error) {
    console.error("[auth] could not revoke sessions on sign-out", error instanceof Error ? error.message : error);
  }
}
