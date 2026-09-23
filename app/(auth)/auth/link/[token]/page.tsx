import type { Metadata } from "next";

import { LinkSignIn } from "./link-sign-in";

// The URL carries a credential: never index it, never send it on as a referrer.
export const metadata: Metadata = {
  title: "Signing you in",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

/**
 * A person's private sign-in link (lib/auth/login-link.ts, docs/LOGIN-LINKS.md).
 * Public route (middleware lets /auth/link/* through). Nothing is checked on the
 * server here: the page only hands the token to the client, which signs in with
 * the "link" Credentials provider, so a link preview that fetches the page
 * without running scripts never signs anyone in.
 */
export default async function LinkSignInPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <LinkSignIn token={token} />;
}
