import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import {
  GOOGLE_AUTHORIZE_URL,
  GOOGLE_TOKEN_URL,
  GMAIL_SCOPES,
  type GoogleTokenResponse,
} from "./types";
import { GmailApiError, GmailReauthRequiredError } from "./errors";

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Build the Google consent URL for one business's OAuth client.
 *
 * `access_type=offline` + `prompt=consent` guarantee a refresh token every time
 * (Google only returns one on the FIRST consent otherwise). `hd` restricts the
 * account picker to the business's Workspace domain when known. Internal-type
 * apps need no verification, so this stays inside the org.
 */
export function buildAuthorizeUrl(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
  loginHint?: string;
  hd?: string;
}): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    scope: GMAIL_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state: opts.state,
  });
  if (opts.loginHint) params.set("login_hint", opts.loginHint);
  if (opts.hd) params.set("hd", opts.hd);
  return `${GOOGLE_AUTHORIZE_URL}?${params.toString()}`;
}

async function requestToken(
  params: Record<string, string>,
): Promise<GoogleTokenResponse> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = (body as { error?: string }).error;
    // A revoked grant / dead refresh token cannot be recovered automatically.
    if (err === "invalid_grant") {
      throw new GmailReauthRequiredError(`Google token exchange failed: ${err}`);
    }
    throw new GmailApiError(res.status, `Google token exchange failed: ${err ?? res.status}`);
  }
  return body as GoogleTokenResponse;
}

export function exchangeCodeForTokens(opts: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<GoogleTokenResponse> {
  return requestToken({
    grant_type: "authorization_code",
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    code: opts.code,
    redirect_uri: opts.redirectUri,
  });
}

export function refreshAccessToken(opts: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<GoogleTokenResponse> {
  return requestToken({
    grant_type: "refresh_token",
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    refresh_token: opts.refreshToken,
  });
}

/* --- Signed state cookie (CSRF + carries businessId) -------------------- */
type StatePayload = { businessId: string; state: string; exp: number };

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
