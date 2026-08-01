import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import Nodemailer from "next-auth/providers/nodemailer";

/**
 * Auth.js (NextAuth v5) configuration.
 *
 * Providers are configured but NOT yet wired to a database adapter.
 *
 * NOTE: The Nodemailer (magic-link) provider requires a database adapter to
 * persist verification tokens — it will not complete sign-in until an adapter
 * is attached. When ready, add the Drizzle adapter:
 *
 *   import { DrizzleAdapter } from "@auth/drizzle-adapter";
 *   import { db } from "@/lib/db";
 *   ...
 *   adapter: DrizzleAdapter(db),
 *
 * See lib/db/schema.ts for the Auth.js table definitions.
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  // adapter: DrizzleAdapter(db), // TODO: wire up before enabling magic links
  providers: [
    Google({
      clientId: process.env.AUTH_GOOGLE_ID,
      clientSecret: process.env.AUTH_GOOGLE_SECRET,
    }),
    Nodemailer({
      server: process.env.EMAIL_SERVER,
      from: process.env.EMAIL_FROM,
    }),
  ],
  pages: {
    signIn: "/login",
  },
});
