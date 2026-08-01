import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";

import { authConfig, type Role } from "./config";
import { authenticate } from "./login";

/**
 * Full Auth.js (NextAuth v5) config: the edge-safe base + the email/password
 * Credentials provider. Sessions are JWT (no adapter, no session table lookups)
 * and carry the user's id and role so middleware can gate access on the edge.
 *
 * Users are created by an admin or the seed script — there is no signup.
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      authorize: async (creds) => {
        const email = creds?.email;
        const password = creds?.password;
        if (typeof email !== "string" || typeof password !== "string") {
          return null;
        }
        // Returns the user, null (bad creds), or throws AccountLockedError.
        return await authenticate(email, password);
      },
    }),
  ],
});

export type SessionUser = { id: string; role: Role };

/**
 * Current user as a RequestUser for withUserContext, or null if signed out.
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  const session = await auth();
  if (!session?.user) return null;
  return { id: session.user.id, role: session.user.role };
}
