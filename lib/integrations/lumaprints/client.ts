import { LumaPrintsApiError, LumaPrintsAuthError } from "./errors";
import { findLumaFixtureByExternalId, findLumaFixtureByOrderNumber, LUMAPRINTS_SHIPMENT_FIXTURES } from "./fixtures";
import {
  LUMAPRINTS_BASE,
  type LumaOrder,
  type LumaOrdersPage,
  type LumaPrintsCredentials,
  type LumaShipmentsResponse,
} from "./types";
import type { NormalizedProviderOrder, PrintProviderClient } from "@/lib/print/provider-types";

const RATE_LIMIT_PER_SEC = 5;
const MIN_INTERVAL_MS = 1000 / RATE_LIMIT_PER_SEC;
const MAX_ATTEMPTS = 4;
const MAX_SCAN_PAGES = 10; // cap the client-side externalId scan (see findByReference)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let lastCallAt = 0;
async function throttle(): Promise<void> {
  const wait = lastCallAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastCallAt = Date.now();
}

function log(event: string, fields: Record<string, unknown>) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), integration: "lumaprints", event, ...fields }));
}

function isMockMode(): boolean {
  return process.env.PRINT_PROVIDER_MOCK === "1";
}

function statusToNormalized(status: string): NormalizedProviderOrder["status"] {
  const s = status.toLowerCase();
  if (s.includes("shipped")) return "shipped";
  if (s.includes("delivered")) return "delivered";
  if (s.includes("cancel")) return "canceled";
  if (s.includes("hold") || s.includes("fail") || s.includes("reject")) return "failed";
  if (s.includes("production") || s.includes("printed")) return "printed";
  return "created"; // "Awaiting Fulfillment" and anything unrecognized
}

function toNormalized(order: LumaOrder, shipments: LumaShipmentsResponse | null): NormalizedProviderOrder {
  const normalizedStatus = statusToNormalized(order.orderStatus);
  return {
    provider: "lumaprints",
    providerOrderId: order.orderNumber,
    referenceId: order.externalId,
    status: shipments?.shipments.length ? "shipped" : normalizedStatus,
    rawStatus: order.orderStatus,
    reason: normalizedStatus === "failed" || normalizedStatus === "canceled" ? `Luma Prints reported the order as "${order.orderStatus}".` : null,
    shipments: (shipments?.shipments ?? []).map((s) => ({
      trackingNumber: s.trackingNumber,
      carrier: s.carrier,
      trackingUrl: null, // not part of the documented shipment schema
      shippedAt: s.shipmentDate,
    })),
    raw: { order, shipments },
  };
}

export class LumaPrintsClient implements PrintProviderClient {
  readonly provider = "lumaprints" as const;
  private credentials: LumaPrintsCredentials;

  constructor(credentials: LumaPrintsCredentials) {
    this.credentials = credentials;
  }

  private baseUrl(): string {
    return this.credentials.sandbox ? LUMAPRINTS_BASE.sandbox : LUMAPRINTS_BASE.production;
  }

  private authHeader(): string {
    const token = Buffer.from(`${this.credentials.username}:${this.credentials.password}`).toString("base64");
    return `Basic ${token}`;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (isMockMode()) throw new Error("request() must not be called in mock mode");
    let attempt = 0;
    let lastError: unknown = null;
    while (attempt < MAX_ATTEMPTS) {
      attempt += 1;
      await throttle();
      try {
        const res = await fetch(`${this.baseUrl()}${path}`, {
          ...init,
          headers: {
            "Content-Type": "application/json",
            Authorization: this.authHeader(),
            ...(init.headers ?? {}),
          },
        });
        if (res.status === 401 || res.status === 403) throw new LumaPrintsAuthError(`Luma Prints ${path} -> ${res.status}`);
        if (res.status === 429 || res.status >= 500) {
          lastError = new LumaPrintsApiError(res.status, `Luma Prints ${path} -> ${res.status}`);
          log("retryable_error", { path, status: res.status, attempt });
          await sleep(500 * attempt);
          continue;
        }
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          throw new LumaPrintsApiError(res.status, `Luma Prints ${path} -> ${res.status}: ${body.slice(0, 300)}`);
        }
        return (await res.json()) as T;
      } catch (error) {
        if (error instanceof LumaPrintsAuthError) throw error;
        lastError = error;
        log("call_failed", { path, attempt, error: error instanceof Error ? error.message : String(error) });
      }
    }
    throw lastError instanceof Error ? lastError : new LumaPrintsApiError(0, "Luma Prints request failed after retries");
  }

  private async getShipments(orderNumber: string): Promise<LumaShipmentsResponse | null> {
    if (isMockMode()) return LUMAPRINTS_SHIPMENT_FIXTURES[orderNumber] ?? null;
    try {
      return await this.request<LumaShipmentsResponse>(`/api/v1/shipments/${encodeURIComponent(orderNumber)}`);
    } catch (error) {
      if (error instanceof LumaPrintsApiError && error.status === 404) return null;
      throw error;
    }
  }

  async getOrder(providerOrderId: string): Promise<NormalizedProviderOrder | null> {
    if (isMockMode()) {
      const order = findLumaFixtureByOrderNumber(providerOrderId);
      if (!order) return null;
      const shipments = await this.getShipments(providerOrderId);
      return toNormalized(order, shipments);
    }
    try {
      const order = await this.request<LumaOrder>(`/api/v1/orders/${encodeURIComponent(providerOrderId)}`);
      const shipments = await this.getShipments(providerOrderId);
      return toNormalized(order, shipments);
    } catch (error) {
      if (error instanceof LumaPrintsApiError && error.status === 404) return null;
      throw error;
    }
  }

  /**
   * IMPORTANT DOCUMENTED LIMITATION: `GET /api/v1/orders` (api-docs.lumaprints.com
   * -> "Get multiple orders") filters only by `storeId`, `orderDateStart` /
   * `orderDateEnd`, and pages by `page` - there is no `externalId` or order
   * number filter. To find "the order the VA sent this to Luma as", we must
   * page through the store's orders in the date window ourselves and match
   * `externalId` client-side. Capped at MAX_SCAN_PAGES so an old date window
   * can't turn one reconcile tick into an unbounded scan; a match older than
   * that window will surface as "missing" until the window is widened.
   */
  async findByReference(referenceId: string, window: { since: Date }): Promise<NormalizedProviderOrder | null> {
    if (isMockMode()) {
      const order = findLumaFixtureByExternalId(referenceId);
      if (!order) return null;
      const shipments = await this.getShipments(order.orderNumber);
      return toNormalized(order, shipments);
    }
    const orderDateStart = window.since.toISOString().slice(0, 10);
    for (let page = 1; page <= MAX_SCAN_PAGES; page += 1) {
      const qs = new URLSearchParams({
        storeId: this.credentials.storeId,
        orderDateStart,
        page: String(page),
      });
      const result = await this.request<LumaOrdersPage>(`/api/v1/orders?${qs.toString()}`);
      const match = result.orders.find((o) => o.externalId === referenceId);
      if (match) {
        const shipments = await this.getShipments(match.orderNumber);
        return toNormalized(match, shipments);
      }
      if (page >= result.totalPages) break;
    }
    return null;
  }
}
