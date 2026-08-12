import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";

import { auth } from "@/lib/auth";
import { withUserContext } from "@/lib/db";
import { getShopCredentials, setShopCredentials } from "@/lib/db/credentials";
import { shops } from "@/lib/db/schema";
import { ensureBackfillCutoff } from "@/lib/orders/archive";
import {
  discoverEtsyShopId,
  exchangeCodeForTokens,
  verifyOAuthState,
  type EtsyCredentials,
  type EtsyIntegrationConfig,
} from "@/lib/integrations/etsy";
import { eq } from "drizzle-orm";

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

    const etsyUserId = tok.access_token.split(".")[0];
    const etsyShopId = await discoverEtsyShopId({
      ...creds,
      accessToken: tok.access_token,
      etsyUserId,
    });

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
    await withUserContext(user, async (tx) => {
      await setShopCredentials(tx, shopId, updated);
      const [s] = await tx.select({ cfg: shops.integrationConfig }).from(shops).where(eq(shops.id, shopId));
      await tx
        .update(shops)
        .set({ integrationConfig: ensureBackfillCutoff((s?.cfg ?? {}) as EtsyIntegrationConfig) })
        .where(eq(shops.id, shopId));
    });

    return settings("connected=1");
  } catch {
    return settings("error=oauth_exchange");
  }
}
