import { eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";

import { auth } from "@/lib/auth";
import { withUserContext } from "@/lib/db";
import { shops } from "@/lib/db/schema";
import { getShopCredentials } from "@/lib/db/credentials";
import {
  buildAuthorizeUrl,
  codeChallenge,
  generateCodeVerifier,
  newState,
  signOAuthState,
  ETSY_SCOPES_DRAFT_LISTINGS_ONLY,
  type EtsyCredentials,
  type EtsyIntegrationConfig,
} from "@/lib/integrations/etsy";

export const runtime = "nodejs";
const OAUTH_COOKIE = "etsy_oauth";

export async function GET(req: NextRequest) {
  const origin = req.nextUrl.origin;
  const session = await auth();
  if (session?.user?.role !== "admin") {
    return NextResponse.redirect(new URL("/login", origin));
  }

  const shopId = req.nextUrl.searchParams.get("shopId");
  if (!shopId) {
    return NextResponse.redirect(new URL("/settings?error=missing_shop", origin));
  }

  const user = { id: session.user.id, role: session.user.role };
  const { creds, scopePurpose } = await withUserContext(user, async (tx) => {
    const [row] = await tx
      .select({ cfg: shops.integrationConfig })
      .from(shops)
      .where(eq(shops.id, shopId));
    return {
      creds: (await getShopCredentials(tx, shopId)) as EtsyCredentials,
      scopePurpose: (row?.cfg as EtsyIntegrationConfig | null)?.etsyScopePurpose,
    };
  });

  if (!creds.keystring) {
    return NextResponse.redirect(new URL("/settings?error=no_keystring", origin));
  }

  const verifier = generateCodeVerifier();
  const challenge = codeChallenge(verifier);
  const state = newState();
  const redirectUri = process.env.ETSY_OAUTH_REDIRECT_URI!;

  // A shop marked draft_listings_only (e.g. AY's own key) never requests
  // listings_d or order/customer scopes: the token it gets back is
  // structurally unable to delete or sync anything, regardless of what the
  // app is asked to do.
  const scopes =
    scopePurpose === "draft_listings_only" ? ETSY_SCOPES_DRAFT_LISTINGS_ONLY : undefined;

  const authorizeUrl = buildAuthorizeUrl({
    keystring: creds.keystring,
    redirectUri,
    state,
    challenge,
    scopes,
  });

  const jar = await cookies();
  jar.set(OAUTH_COOKIE, signOAuthState({ shopId, verifier, state, exp: Date.now() + 10 * 60 * 1000 }), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 600,
  });

  return NextResponse.redirect(authorizeUrl);
}
