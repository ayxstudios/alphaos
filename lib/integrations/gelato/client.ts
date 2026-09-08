import { GelatoApiError, GelatoAuthError } from "./errors";
import { findGelatoFixtureByReference, findGelatoFixtureById } from "./fixtures";
import { GELATO_ORDER_BASE, type GelatoCredentials, type GelatoOrder, type GelatoSearchResponse } from "./types";
import type { NormalizedProviderOrder, PrintProviderClient } from "@/lib/print/provider-types";

// Gelato does not publish a documented per-key rate limit; be a polite
// citizen and cap our own calls the same way we cap Etsy's (headroom, not a
// measured ceiling).
const RATE_LIMIT_PER_SEC = 5;
const MIN_INTERVAL_MS = 1000 / RATE_LIMIT_PER_SEC;
const MAX_ATTEMPTS = 4;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let lastCallAt = 0;
async function throttle(): Promise<void> {
  const wait = lastCallAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastCallAt = Date.now();
}

function log(event: string, fields: Record<string, unknown>) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), integration: "gelato", event, ...fields }));
}

function gelatoStatusToNormalized(order: GelatoOrder): NormalizedProviderOrder {
  const shipments = order.items.flatMap((item) =>
    (item.fulfillments ?? []).map((f) => ({
      trackingNumber: f.trackingCode,
      carrier: f.shipmentMethodName ?? f.shipmentMethodUid ?? null,
      trackingUrl: f.trackingUrl,
      shippedAt: order.updatedAt ?? null,
    })),
  );
  const statusMap: Record<string, NormalizedProviderOrder["status"]> = {
    created: "created",
    passed: "created",
    printed: "printed",
    shipped: "shipped",
    delivered: "delivered",
    failed: "failed",
    canceled: "canceled",
  };
  return {
    provider: "gelato",
    providerOrderId: order.id,
    referenceId: order.orderReferenceId ?? null,
    status: statusMap[order.fulfillmentStatus] ?? "created",
    rawStatus: order.fulfillmentStatus,
    reason: order.fulfillmentStatus === "failed" || order.fulfillmentStatus === "canceled" ? "Gelato reported the order as " + order.fulfillmentStatus + "." : null,
    shipments,
    raw: order,
  };
}

function isMockMode(): boolean {
  return process.env.PRINT_PROVIDER_MOCK === "1";
}

export class GelatoClient implements PrintProviderClient {
  readonly provider = "gelato" as const;
  private credentials: GelatoCredentials;

  constructor(credentials: GelatoCredentials) {
    this.credentials = credentials;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (isMockMode()) throw new Error("request() must not be called in mock mode");
    let attempt = 0;
    let lastError: unknown = null;
    while (attempt < MAX_ATTEMPTS) {
      attempt += 1;
      await throttle();
      try {
        const res = await fetch(`${GELATO_ORDER_BASE}${path}`, {
          ...init,
          headers: {
            "Content-Type": "application/json",
            "X-API-KEY": this.credentials.apiKey,
            ...(init.headers ?? {}),
          },
        });
        if (res.status === 401 || res.status === 403) {
          throw new GelatoAuthError(`Gelato ${path} -> ${res.status}`);
        }
        if (res.status === 429 || res.status >= 500) {
          lastError = new GelatoApiError(res.status, `Gelato ${path} -> ${res.status}`);
          log("retryable_error", { path, status: res.status, attempt });
          await sleep(500 * attempt);
          continue;
        }
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          throw new GelatoApiError(res.status, `Gelato ${path} -> ${res.status}: ${body.slice(0, 300)}`);
        }
        return (await res.json()) as T;
      } catch (error) {
        if (error instanceof GelatoAuthError) throw error;
        lastError = error;
        log("call_failed", { path, attempt, error: error instanceof Error ? error.message : String(error) });
      }
    }
    throw lastError instanceof Error ? lastError : new GelatoApiError(0, "Gelato request failed after retries");
  }

  async getOrder(providerOrderId: string): Promise<NormalizedProviderOrder | null> {
    if (isMockMode()) {
      const fixture = findGelatoFixtureById(providerOrderId);
      return fixture ? gelatoStatusToNormalized(fixture) : null;
    }
    try {
      const order = await this.request<GelatoOrder>(`/v4/orders/${encodeURIComponent(providerOrderId)}`);
      return gelatoStatusToNormalized(order);
    } catch (error) {
      if (error instanceof GelatoApiError && error.status === 404) return null;
      throw error;
    }
  }

  /**
   * Search v4 (`POST /v4/orders:search`) is documented with `orderTypes` and
   * `countries` filters; an `orderReferenceIds` array filter is the natural
   * extension of the same shape used by the order_status_updated webhook, but
   * it is NOT shown in the public examples we could reach - verify against a
   * live key before trusting an empty result as authoritative. We fall back to
   * a client-side scan of the returned page when the filter is ignored.
   */
  async findByReference(referenceId: string, window: { since: Date }): Promise<NormalizedProviderOrder | null> {
    if (isMockMode()) {
      const fixture = findGelatoFixtureByReference(referenceId);
      return fixture ? gelatoStatusToNormalized(fixture) : null;
    }
    const body = {
      orderReferenceIds: [referenceId],
      orderTypes: ["order"],
      startDate: window.since.toISOString(),
      limit: 25,
    };
    const result = await this.request<GelatoSearchResponse>("/v4/orders:search", {
      method: "POST",
      body: JSON.stringify(body),
    });
    const match = result.orders.find((order) => order.orderReferenceId === referenceId);
    return match ? gelatoStatusToNormalized(match) : null;
  }
}
