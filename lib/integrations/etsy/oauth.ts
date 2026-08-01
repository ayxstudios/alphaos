import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import {
  ETSY_AUTHORIZE_URL,
  ETSY_TOKEN_URL,
  ETSY_SCOPES,
  type EtsyTokenResponse,
} from "./types";
import { EtsyApiError, ReauthRequiredError } from "./errors";

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/* --- PKCE --------------------------------------------------------------- */
export function generateCodeVerifier(): string {
  return base64url(randomBytes(48)); // 64 chars, within Etsy's 43–128 range
}

export function codeChallenge(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}

export function buildAuthorizeUrl(opts: {
  keystring: string;
  redirectUri: string;
  state: string;
  challenge: string;
}): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: opts.keystring,
    redirect_uri: opts.redirectUri,
    scope: ETSY_SCOPES.join(" "),
    state: opts.state,
    code_challenge: opts.challenge,
    code_challenge_method: "S256",
  });
  return `${ETSY_AUTHORIZE_URL}?${params.toString()}`;
}

/* --- Token endpoint ----------------------------------------------------- */
async function requestToken(
  params: Record<string, string>,
): Promise<EtsyTokenResponse> {
  const res = await fetch(ETSY_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = (body as { error?: string }).error;
    // A dead refresh token / revoked grant cannot be recovered automatically.
    if (res.status === 400 && (err === "invalid_grant" || err === "invalid_token")) {
      throw new ReauthRequiredError(`Etsy token exchange failed: ${err}`);
    }
    throw new EtsyApiError(res.status, `Etsy token exchange failed: ${err ?? res.status}`);
  }
  return body as EtsyTokenResponse;
}

export function exchangeCodeForTokens(opts: {
  keystring: string;
  code: string;
  verifier: string;
  redirectUri: string;
}): Promise<EtsyTokenResponse> {
  return requestToken({
    grant_type: "authorization_code",
    client_id: opts.keystring,
    redirect_uri: opts.redirectUri,
    code: opts.code,
    code_verifier: opts.verifier,
  });
}

export function refreshTokens(opts: {
  keystring: string;
  refreshToken: string;
}): Promise<EtsyTokenResponse> {
  return requestToken({
    grant_type: "refresh_token",
    client_id: opts.keystring,
    refresh_token: opts.refreshToken,
  });
}

/* --- Signed state cookie (CSRF + carries shopId & PKCE verifier) --------- */
type StatePayload = { shopId: string; verifier: string; state: string; exp: number };

function hmacKey(): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is not set");
  return secret;
}

export function signOAuthState(payload: StatePayload): string {
  const data = base64url(Buffer.from(JSON.stringify(payload)));
  const sig = base64url(createHmac("sha256", hmacKey()).update(data).digest());
  return `${data}.${sig}`;
}

export function verifyOAuthState(cookie: string | undefined): StatePayload | null {
  if (!cookie) return null;
  const [data, sig] = cookie.split(".");
  if (!data || !sig) return null;
  const expected = base64url(createHmac("sha256", hmacKey()).update(data).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, "base64").toString("utf8")) as StatePayload;
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export function newState(): string {
  return base64url(randomBytes(16));
}
