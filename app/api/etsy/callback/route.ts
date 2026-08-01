import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";

import { auth } from "@/lib/auth";
import { withUserContext } from "@/lib/db";
import { getShopCredentials, setShopCredentials } from "@/lib/db/credentials";
import {
  exchangeCodeForTokens,
  verifyOAuthState,
  type EtsyCredentials,
} from "@/lib/integrations/etsy";
import { ETSY_API_BASE } from "@/lib/integrations/etsy/types";

export const runtime = "nodejs";
const OAUTH_COOKIE = "etsy_oauth";
const REFRESH_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;

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
    return settings("error=oauth_state");
  }

  const { shopId, verifier } = payload;
  const user = { id: session.user.id, role: session.user.role };
  const creds = (await withUserContext(user, (tx) =>
    getShopCredentials(tx, shopId),
  )) as EtsyCredentials;
  if (!creds.keystring) return settings("error=no_keystring");

  try {
    const tok = await exchangeCodeForTokens({
      keystring: creds.keystring,
      code,
      verifier,
      redirectUri: process.env.ETSY_OAUTH_REDIRECT_URI!,
    });

    // Etsy access tokens are "<user_id>.<random>"; the prefix is the user id.
    const etsyUserId = tok.access_token.split(".")[0];
    let etsyShopId = creds.etsyShopId;
    try {
      const r = await fetch(`${ETSY_API_BASE}/users/${etsyUserId}/shops`, {
        headers: { "x-api-key": creds.keystring, Authorization: `Bearer ${tok.access_token}` },
      });
      if (r.ok) {
        const d = await r.json();
        etsyShopId = String(d?.shop_id ?? d?.results?.[0]?.shop_id ?? etsyShopId ?? "");
      }
    } catch {
      // best-effort; falls back to shops.external_shop_id during sync
    }

    const now = Date.now();
    const updated: EtsyCredentials = {
      ...creds,
      accessToken: tok.access_token,
      accessTokenExpiresAt: new Date(now + tok.expires_in * 1000).toISOString(),
      refreshToken: tok.refresh_token,
      refreshTokenExpiresAt: new Date(now + REFRESH_TOKEN_TTL_MS).toISOString(),
      status: "connected",
      etsyUserId,
      etsyShopId,
    };
    await withUserContext(user, (tx) => setShopCredentials(tx, shopId, updated));

    return settings("connected=1");
  } catch {
    return settings("error=oauth_exchange");
  }
}
