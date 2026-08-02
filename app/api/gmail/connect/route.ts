import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";

import { auth } from "@/lib/auth";
import { withUserContext } from "@/lib/db";
import { getBusinessGmailCredentials } from "@/lib/db/credentials";
import { businesses } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { buildAuthorizeUrl, newState, signOAuthState, type GmailCredentials } from "@/lib/integrations/gmail";
import { appUrl } from "@/lib/urls";

export const runtime = "nodejs";
const OAUTH_COOKIE = "gmail_oauth";

/**
 * Start the per-business Gmail OAuth flow (admin only). The business must already
 * have its OAuth client id/secret saved (Settings → Gmail card). Carries the
 * businessId in a signed, short-lived state cookie.
 */
export async function GET(req: NextRequest) {
  const origin = req.nextUrl.origin;
  const session = await auth();
  if (session?.user?.role !== "admin") {
    return NextResponse.redirect(new URL("/login", origin));
  }

  const businessId = req.nextUrl.searchParams.get("businessId");
  if (!businessId) {
    return NextResponse.redirect(new URL("/settings?error=missing_business", origin));
  }

  const user = { id: session.user.id, role: session.user.role };
  const { creds, biz } = await withUserContext(user, async (tx) => {
    const c = (await getBusinessGmailCredentials(tx, businessId)) as GmailCredentials | null;
    const [b] = await tx
      .select({ tenantDomain: businesses.gmailTenantDomain })
      .from(businesses)
      .where(eq(businesses.id, businessId));
    return { creds: c, biz: b };
  });

  if (!creds?.clientId) {
    return NextResponse.redirect(new URL("/settings?error=no_gmail_client", origin));
  }

  const state = newState();
  const authorizeUrl = buildAuthorizeUrl({
    clientId: creds.clientId,
    redirectUri: appUrl("/api/gmail/callback"),
    state,
    loginHint: creds.address,
    hd: biz?.tenantDomain ?? undefined,
  });

  const jar = await cookies();
  jar.set(OAUTH_COOKIE, signOAuthState({ businessId, state, exp: Date.now() + 10 * 60 * 1000 }), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 600,
  });

  return NextResponse.redirect(authorizeUrl);
}
