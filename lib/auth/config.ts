import type { NextAuthConfig } from "next-auth";

export type Role = "admin" | "va" | "designer";

/**
 * Edge-safe Auth.js config: only the JWT/session callbacks that carry
 * `id`/`role`. No providers, no DB, no Node-only code — so `middleware.ts` can
 * import it and decode the JWT on the edge without a DB round-trip.
 *
 * The Credentials provider (which needs bcrypt + the database) lives only in
 * the full config, lib/auth/index.ts, used by the route handler and `auth()`.
 */
export const authConfig = {
  // Explicit so the edge middleware bundle always has it (env inlining into the
  // edge runtime is unreliable); trustHost avoids host-normalization issues.
  secret: process.env.AUTH_SECRET,
  trustHost: true,
  pages: { signIn: "/login" },
  session: { strategy: "jwt" },
  providers: [],
  callbacks: {
    jwt({ token, user }) {
      // `user` is only present on sign-in; it's the authenticated row.
      if (user) {
        token.id = user.id;
        token.role = (user as { role?: Role }).role ?? "designer";
      }
      return token;
    },
    session({ session, token }) {
      if (session.user) {
        session.user.id = (token.id as string) ?? session.user.id;
        session.user.role = (token.role as Role) ?? "designer";
      }
      return session;
    },
  },
} satisfies NextAuthConfig;
