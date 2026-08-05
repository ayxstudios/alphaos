import { eq, sql } from "drizzle-orm";

import { withSystemContext, type Tx } from "@/lib/db";
import { getShopCredentials, setShopCredentials } from "@/lib/db/credentials";
import { users, notifications } from "@/lib/db/schema";
import { refreshTokens } from "./oauth";
import { EtsyApiError, ReauthRequiredError } from "./errors";
import { ETSY_API_BASE, type EtsyCredentials } from "./types";

const RATE_LIMIT_PER_SEC = 5; // headroom under Etsy's 10/sec
const MIN_INTERVAL_MS = 1000 / RATE_LIMIT_PER_SEC; // 200ms steady spacing
const MAX_ATTEMPTS = 5;
const REFRESH_BUFFER_MS = 120_000; // refresh if <2min to expiry
const REFRESH_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type EtsyShopsResponse = {
  shop_id?: number | string;
  results?: { shop_id?: number | string }[];
};

export function etsyApiKey(creds: Pick<EtsyCredentials, "keystring" | "sharedSecret">): string {
  if (!creds.keystring || !creds.sharedSecret) {
    throw new ReauthRequiredError("Missing Etsy keystring or shared secret");
  }
  return `${creds.keystring}:${creds.sharedSecret}`;
}

function extractNumericShopId(data: EtsyShopsResponse): string {
  const shopId = String(data.shop_id ?? data.results?.[0]?.shop_id ?? "");
  if (!/^\d+$/.test(shopId)) {
    throw new EtsyApiError(0, "Etsy shop lookup did not return a numeric shop_id");
  }
  return shopId;
}

export async function discoverEtsyShopId(creds: EtsyCredentials): Promise<string> {
  if (!creds.accessToken) throw new ReauthRequiredError("Missing Etsy access token");

  const etsyUserId = creds.etsyUserId ?? creds.accessToken.split(".")[0];
  if (!etsyUserId) throw new ReauthRequiredError("Missing Etsy user id");

  const res = await fetch(`${ETSY_API_BASE}/users/${etsyUserId}/shops`, {
    headers: {
      "x-api-key": etsyApiKey(creds),
      Authorization: `Bearer ${creds.accessToken}`,
      Accept: "application/json",
    },
  });
  const body = await res.text();
  if (!res.ok) {
    throw new EtsyApiError(res.status, `Etsy shop lookup failed: ${res.status} ${body.slice(0, 200)}`);
  }

  return extractNumericShopId(JSON.parse(body) as EtsyShopsResponse);
}

/**
 * Etsy Open API v3 client for one shop. Handles: 5/sec rate limiting,
 * exponential backoff on 429/5xx, structured logging of every call, and access
 * token refresh (proactive + reactive) with a row lock so concurrent refreshes
 * can't invalidate each other. Tokens are never logged.
 */
export class EtsyClient {
  private creds: EtsyCredentials;
  private lastRequestAt = 0;

  constructor(
    private readonly shopId: string,
    private readonly businessId: string,
    creds: EtsyCredentials,
  ) {
    this.creds = { ...creds };
  }

  async apiGet<T>(path: string): Promise<T> {
    let didReauth = false;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const token = await this.ensureAccessToken();
      await this.throttle();
      const start = Date.now();
      const res = await fetch(`${ETSY_API_BASE}${path}`, {
        headers: {
          "x-api-key": etsyApiKey(this.creds),
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
      });
      this.log({
        method: "GET",
        path,
        status: res.status,
        ms: Date.now() - start,
        attempt,
        remainingThisSecond: res.headers.get("x-remaining-this-second"),
        remainingToday: res.headers.get("x-remaining-today"),
      });

      if (res.ok) return (await res.json()) as T;

      if (res.status === 401 && !didReauth) {
        didReauth = true;
        await this.refresh();
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        if (attempt === MAX_ATTEMPTS) {
          throw new EtsyApiError(res.status, `Etsy GET ${path} failed after ${attempt} attempts`);
        }
        await sleep(this.backoffMs(res, attempt));
        continue;
      }
      const body = await res.text().catch(() => "");
      throw new EtsyApiError(res.status, `Etsy GET ${path}: ${res.status} ${body.slice(0, 200)}`);
    }
    throw new EtsyApiError(0, `Etsy GET ${path}: exhausted attempts`);
  }

  get credentials(): EtsyCredentials {
    return this.creds;
  }

  async discoverShopId(): Promise<string> {
    const etsyUserId = this.creds.etsyUserId ?? this.creds.accessToken?.split(".")[0];
    if (!etsyUserId) throw new ReauthRequiredError("Missing Etsy user id");
    return extractNumericShopId(
      await this.apiGet<EtsyShopsResponse>(`/users/${etsyUserId}/shops`),
    );
  }

  /* --- token lifecycle -------------------------------------------------- */
  private tokenValid(): boolean {
    return (
      !!this.creds.accessToken &&
      !!this.creds.accessTokenExpiresAt &&
      new Date(this.creds.accessTokenExpiresAt).getTime() > Date.now() + REFRESH_BUFFER_MS
    );
  }

  private async ensureAccessToken(): Promise<string> {
    if (this.creds.status === "needs_reauth") throw new ReauthRequiredError();
    if (this.tokenValid()) return this.creds.accessToken!;
    return this.refresh();
  }

  private async refresh(): Promise<string> {
    return withSystemContext(async (tx) => {
      // Lock the shop row for the refresh so concurrent refreshes serialize —
      // a rotated refresh token would otherwise invalidate the other worker's.
      await tx.execute(sql`select id from shops where id = ${this.shopId} for update`);

      const fresh = (await getShopCredentials(tx, this.shopId)) as EtsyCredentials;
      // Double-check: another worker may have refreshed while we waited.
      if (
        fresh.accessToken &&
        fresh.accessTokenExpiresAt &&
        new Date(fresh.accessTokenExpiresAt).getTime() > Date.now() + REFRESH_BUFFER_MS
      ) {
        this.creds = { ...fresh };
        return fresh.accessToken;
      }
      if (!fresh.refreshToken || !fresh.keystring) {
        throw new ReauthRequiredError("Missing refresh token or keystring");
      }

      try {
        const tok = await refreshTokens({
          keystring: fresh.keystring,
          refreshToken: fresh.refreshToken,
        });
        const now = Date.now();
        const updated: EtsyCredentials = {
          ...fresh,
          accessToken: tok.access_token,
          accessTokenExpiresAt: new Date(now + tok.expires_in * 1000).toISOString(),
          refreshToken: tok.refresh_token,
          refreshTokenExpiresAt: new Date(now + REFRESH_TOKEN_TTL_MS).toISOString(),
          status: "connected",
        };
        await setShopCredentials(tx, this.shopId, updated);
        this.creds = updated;
        this.log({ event: "token_refreshed" });
        return tok.access_token;
      } catch (err) {
        if (err instanceof ReauthRequiredError) {
          await setShopCredentials(tx, this.shopId, { ...fresh, status: "needs_reauth" });
          this.creds = { ...fresh, status: "needs_reauth" };
          await this.notifyReauth(tx);
          this.log({ event: "reauth_required", level: "error" });
        }
        throw err;
      }
    });
  }

  private async notifyReauth(tx: Tx): Promise<void> {
    const admins = await tx.select({ id: users.id }).from(users).where(eq(users.role, "admin"));
    if (!admins.length) return;
    await tx.insert(notifications).values(
      admins.map((a) => ({
        businessId: this.businessId,
        userId: a.id,
        type: "etsy.reauth_required",
      })),
    );
  }

  /* --- rate limiting + backoff + logging -------------------------------- */
  private async throttle(): Promise<void> {
    const wait = Math.max(0, this.lastRequestAt + MIN_INTERVAL_MS - Date.now());
    if (wait > 0) await sleep(wait);
    this.lastRequestAt = Date.now();
  }

  private backoffMs(res: Response, attempt: number): number {
    const retryAfter = res.headers.get("retry-after");
    if (retryAfter) {
      const secs = Number(retryAfter);
      if (Number.isFinite(secs)) return secs * 1000;
    }
    const base = 500 * 2 ** (attempt - 1);
    return base + Math.floor(Math.random() * 250); // jitter
  }

  private log(extra: Record<string, unknown>): void {
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "info",
        integration: "etsy",
        shopId: this.shopId,
        ...extra,
      }),
    );
  }
}
