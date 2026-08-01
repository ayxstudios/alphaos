import { ShopifyApiError } from "./errors";
import { SHOPIFY_API_VERSION, type ThrottleStatus } from "./types";

const MAX_ATTEMPTS = 5;
// Proactively pause when the cost bucket dips below this many points, so we
// never hard-hit Shopify's throttle mid-run.
const LOW_WATER = 100;
const DEFAULT_RESTORE_RATE = 50; // points/sec (Shopify standard default)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type GraphqlBody<T> = {
  data?: T;
  errors?: { message: string; extensions?: { code?: string } }[];
  extensions?: { cost?: { requestedQueryCost: number; actualQueryCost: number | null; throttleStatus: ThrottleStatus } };
};

/**
 * Shopify Admin GraphQL client for one shop. Respects Shopify's cost-based
 * throttle: it reads `extensions.cost.throttleStatus` from each response and
 * backs off (proactively when the bucket runs low, reactively on THROTTLED/429)
 * using the reported restore rate — no fixed req/sec cap. Every call is logged.
 * The access token is never logged.
 */
export class ShopifyClient {
  private available: number | null = null;
  private restoreRate = DEFAULT_RESTORE_RATE;

  constructor(
    private readonly shopId: string,
    private readonly shopDomain: string,
    private readonly accessToken: string,
  ) {}

  async graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const url = `https://${this.shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await this.throttleAhead();

      const start = Date.now();
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": this.accessToken,
          Accept: "application/json",
        },
        body: JSON.stringify({ query, variables }),
      });

      // HTTP-level throttle (rare with GraphQL, but honor it).
      if (res.status === 429 || res.status >= 500) {
        this.log({ status: res.status, ms: Date.now() - start, attempt, event: "http_retry" });
        if (attempt === MAX_ATTEMPTS) {
          throw new ShopifyApiError(res.status, `Shopify GraphQL failed after ${attempt} attempts`);
        }
        await sleep(this.backoffMs(res, attempt));
        continue;
      }

      const body = (await res.json().catch(() => ({}))) as GraphqlBody<T>;
      const cost = body.extensions?.cost;
      if (cost) {
        this.available = cost.throttleStatus.currentlyAvailable;
        this.restoreRate = cost.throttleStatus.restoreRate || DEFAULT_RESTORE_RATE;
      }
      this.log({
        method: "POST",
        path: "graphql",
        status: res.status,
        ms: Date.now() - start,
        attempt,
        cost: cost?.actualQueryCost ?? cost?.requestedQueryCost ?? null,
        available: this.available,
        restoreRate: this.restoreRate,
      });

      const throttled = body.errors?.some((e) => e.extensions?.code === "THROTTLED");
      if (throttled) {
        if (attempt === MAX_ATTEMPTS) {
          throw new ShopifyApiError(429, "Shopify GraphQL throttled (exhausted retries)");
        }
        const requested = cost?.requestedQueryCost ?? LOW_WATER;
        const deficit = Math.max(1, requested - (this.available ?? 0));
        await sleep((deficit / this.restoreRate) * 1000 + 250);
        continue;
      }

      if (body.errors?.length) {
        throw new ShopifyApiError(res.status, `Shopify GraphQL: ${body.errors.map((e) => e.message).join("; ").slice(0, 300)}`);
      }
      if (!body.data) throw new ShopifyApiError(res.status, "Shopify GraphQL: empty response");
      return body.data;
    }
    throw new ShopifyApiError(0, "Shopify GraphQL: exhausted attempts");
  }

  /** Wait for the cost bucket to refill above the low-water mark before firing. */
  private async throttleAhead(): Promise<void> {
    if (this.available !== null && this.available < LOW_WATER) {
      const deficit = LOW_WATER - this.available;
      await sleep((deficit / this.restoreRate) * 1000);
      this.available = LOW_WATER; // assume refilled; the next response corrects it
    }
  }

  private backoffMs(res: Response, attempt: number): number {
    const retryAfter = res.headers.get("retry-after");
    if (retryAfter) {
      const secs = Number(retryAfter);
      if (Number.isFinite(secs)) return secs * 1000;
    }
    return 500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
  }

  private log(extra: Record<string, unknown>): void {
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "info",
        integration: "shopify",
        shopId: this.shopId,
        ...extra,
      }),
    );
  }
}

/**
 * Verify a shop's Admin API token by fetching the shop name. Standalone (no DB)
 * so Settings can test a token before saving it.
 */
export async function verifyShopifyToken(
  shopDomain: string,
  accessToken: string,
): Promise<{ ok: true; shopName: string } | { ok: false; error: string }> {
  try {
    const res = await fetch(
      `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
          Accept: "application/json",
        },
        body: JSON.stringify({ query: "{ shop { name } }" }),
      },
    );
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: "Token rejected (401/403). Check the access token and scopes." };
    }
    const body = (await res.json().catch(() => ({}))) as GraphqlBody<{ shop: { name: string } }>;
    if (body.errors?.length) return { ok: false, error: body.errors.map((e) => e.message).join("; ") };
    const name = body.data?.shop?.name;
    if (!name) return { ok: false, error: "Unexpected response from Shopify." };
    return { ok: true, shopName: name };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Connection failed" };
  }
}
