import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";

import { auth } from "@/lib/auth";
import { withUserContext } from "@/lib/db";
import {
  getBusinessGmailCredentials,
  setBusinessGmailCredentials,
} from "@/lib/db/credentials";
import {
  exchangeCodeForTokens,
  verifyOAuthState,
  markGmailConnected,
  type GmailCredentials,
} from "@/lib/integrations/gmail";
import { GMAIL_API_BASE } from "@/lib/integrations/gmail/types";
import { appUrl } from "@/lib/urls";

export const runtime = "nodejs";
const OAUTH_COOKIE = "gmail_oauth";

/**
 * Gmail OAuth callback (admin only). Exchanges the code for tokens using the
 * business's own client id/secret, fetches the mailbox profile (address +
 * history cursor for inbound polling), and persists the encrypted credentials.
 */
export async function GET(req: NextRequest) {
  const origin = req.nextUrl.origin;
  const settings = (q: string) => NextResponse.redirect(new URL(`/settings?${q}`, origin));

  const session = await auth();
  if (session?.user?.role !== "admin") {
    return NextResponse.redirect(new URL("/login", origin));
  }

  const code = req.nextUrl.searchParams.get("code");
  const stateParam = req.nextUrl.searchParams.get("state");

  const jar = await cookies();
  const payload = verifyOAuthState(jar.get(OAUTH_COOKIE)?.value);
  jar.delete(OAUTH_COOKIE);

  if (!code || !stateParam || !payload || payload.state !== stateParam) {
    return settings("error=gmail_oauth_state");
  }

  const { businessId } = payload;
  const user = { id: session.user.id, role: session.user.role };
  const creds = (await withUserContext(user, (tx) =>
    getBusinessGmailCredentials(tx, businessId),
  )) as GmailCredentials | null;
  if (!creds?.clientId || !creds.clientSecret) return settings("error=no_gmail_client");

  try {
    const tok = await exchangeCodeForTokens({
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      code,
      redirectUri: appUrl("/api/gmail/callback"),
    });
    if (!tok.refresh_token) {
      // Should not happen with prompt=consent, but never store a half-connection.
      return settings("error=gmail_no_refresh");
    }

    // Fetch the mailbox profile (sending address + history cursor).
    const profileRes = await fetch(`${GMAIL_API_BASE}/users/me/profile`, {
      headers: { Authorization: `Bearer ${tok.access_token}`, Accept: "application/json" },
    });
    if (!profileRes.ok) return settings("error=gmail_profile");
    const profile = (await profileRes.json()) as { emailAddress: string; historyId: string };

    const updated: GmailCredentials = {
      ...creds,
      refreshToken: tok.refresh_token,
      accessToken: tok.access_token,
      accessTokenExpiresAt: new Date(Date.now() + tok.expires_in * 1000).toISOString(),
      address: profile.emailAddress,
      status: "connected",
      connectedAt: new Date().toISOString(),
    };
    await withUserContext(user, async (tx) => {
      await setBusinessGmailCredentials(tx, businessId, updated);
      await markGmailConnected(tx, businessId, {
        address: profile.emailAddress,
        historyId: profile.historyId,
      });
    });

    return settings("gmail_connected=1");
  } catch {
    return settings("error=gmail_oauth_exchange");
  }
}
