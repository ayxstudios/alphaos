import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";

import { auth } from "@/lib/auth";
import { withUserContext } from "@/lib/db";
import { getShopCredentials } from "@/lib/db/credentials";
import {
  buildAuthorizeUrl,
  codeChallenge,
  generateCodeVerifier,
  newState,
  signOAuthState,
  type EtsyCredentials,
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
  const creds = (await withUserContext(user, (tx) =>
    getShopCredentials(tx, shopId),
  )) as EtsyCredentials;

  if (!creds.keystring) {
    return NextResponse.redirect(new URL("/settings?error=no_keystring", origin));
  }

  const verifier = generateCodeVerifier();
  const challenge = codeChallenge(verifier);
  const state = newState();
  const redirectUri = process.env.ETSY_OAUTH_REDIRECT_URI!;

  const authorizeUrl = buildAuthorizeUrl({
    keystring: creds.keystring,
    redirectUri,
    state,
    challenge,
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
