import type { GelatoCreateOrderPayload, GelatoCreateOrderResponse, GelatoOrder } from "./types";

/**
 * PRINT_PROVIDER_MOCK=1 fixtures. Keyed by orderReferenceId (what we look orders
 * up by - the platform order number/name the VA types into Gelato's dashboard).
 * Covers the cases reconcile.ts and scripts/test-print-reconcile.ts exercise:
 * a normal matched+shipped order, one still in production, one that failed, and
 * a reference with nothing at all (simulates "never sent to print").
 */
export const GELATO_FIXTURES: Record<string, GelatoOrder> = {
  "PC-1001": {
    id: "a6a1f9ce-2bdd-4a9e-9f8d-0009df0e24d9",
    orderReferenceId: "PC-1001",
    fulfillmentStatus: "shipped",
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-03T08:00:00.000Z",
    items: [
      {
        id: "item-1",
        itemReferenceId: "1",
        fulfillmentStatus: "shipped",
        fulfillments: [
          {
            trackingCode: "392964503590",
            trackingUrl: "https://example.com/tracking?code=392964503590",
            shipmentMethodName: "DHL Express Domestic",
            shipmentMethodUid: "dhl_express_domestic",
            fulfillmentCountry: "AU",
            fulfillmentStateProvince: null,
            fulfillmentFacilityId: null,
          },
        ],
      },
    ],
  },
  "PC-1002": {
    id: "b7b2f0df-3cee-4b0e-a09e-1119ef1f35ea",
    orderReferenceId: "PC-1002",
    fulfillmentStatus: "printed",
    createdAt: "2026-09-05T10:00:00.000Z",
    updatedAt: "2026-09-06T08:00:00.000Z",
    items: [{ id: "item-1", itemReferenceId: "1", fulfillmentStatus: "printed" }],
  },
  "PC-1003": {
    id: "c8c3f1e0-4dff-4c1f-b1af-2229f0203ffb",
    orderReferenceId: "PC-1003",
    fulfillmentStatus: "failed",
    createdAt: "2026-09-04T10:00:00.000Z",
    updatedAt: "2026-09-04T12:00:00.000Z",
    items: [{ id: "item-1", itemReferenceId: "1", fulfillmentStatus: "failed" }],
  },
  // Exists at Gelato even though AlphaOS never got a "sent to print" click -
  // the self-heal case (approved, no print_jobs row, found anyway).
  "PC-1004": {
    id: "d9d4f2f1-5eff-4d2f-b2bf-3339f0304ffc",
    orderReferenceId: "PC-1004",
    fulfillmentStatus: "created",
    createdAt: "2026-09-06T10:00:00.000Z",
    updatedAt: "2026-09-06T10:00:00.000Z",
    items: [{ id: "item-1", itemReferenceId: "1", fulfillmentStatus: "created" }],
  },
};

/**
 * Mock shops (lib/mock) send orders like PC32041 / LM32007 to print. Any
 * reference outside the static fixtures above is synthesised so the
 * reconcile sweep always finds it: the last digit decides the stage
 * (0-6 shipped with tracking, 7-8 printed, 9 still created), so a demo
 * queue shows a realistic mix and the same order always answers the same.
 */
export function synthesizeGelatoOrder(referenceId: string): GelatoOrder | null {
  const m = referenceId.match(/^([A-Z]{2})-?(\d{4,})$/);
  if (!m) return null;
  const n = Number(m[2]);
  // Only the mock shops' own numbering (lib/mock/data.ts starts at 32000):
  // anything else stays unknown so a real "missing at the provider" case
  // still surfaces as missing.
  if (n < 32000) return null;
  const last = n % 10;
  const status: GelatoOrder["fulfillmentStatus"] = last <= 6 ? "shipped" : last <= 8 ? "printed" : "created";
  const created = new Date(Date.now() - (6 + (n % 5)) * 60 * 60 * 1000).toISOString();
  const tracking = `7${String(n).padStart(11, "0")}`;
  return {
    id: `mock-gelato-${referenceId.toLowerCase()}`,
    orderReferenceId: referenceId,
    fulfillmentStatus: status,
    createdAt: created,
    updatedAt: new Date().toISOString(),
    items: [
      {
        id: "item-1",
        itemReferenceId: "1",
        fulfillmentStatus: status,
        ...(status === "shipped"
          ? {
              fulfillments: [
                {
                  trackingCode: tracking,
                  trackingUrl: `https://www.fedex.com/fedextrack/?trknbr=${tracking}`,
                  shipmentMethodName: "FedEx Ground",
                  shipmentMethodUid: "fedex_ground",
                  fulfillmentCountry: "US",
                  fulfillmentStateProvince: null,
                  fulfillmentFacilityId: null,
                },
              ],
            }
          : {}),
      },
    ],
  };
}

export function findGelatoFixtureByReference(referenceId: string): GelatoOrder | null {
  return GELATO_FIXTURES[referenceId] ?? synthesizeGelatoOrder(referenceId);
}

export function findGelatoFixtureById(id: string): GelatoOrder | null {
  const fixed = Object.values(GELATO_FIXTURES).find((order) => order.id === id);
  if (fixed) return fixed;
  const created = createdMockOrder(id);
  if (created) return created;
  const m = id.match(/^mock-gelato-(.+)$/);
  return m ? synthesizeGelatoOrder(m[1].toUpperCase()) : null;
}

/**
 * Orders created through the mock createOrder (one-tap submit). The id carries
 * the creation time and our reference ("mock-gelato-api-<epochSeconds>-<ref>"),
 * so any later process can answer getOrder without shared state: "created"
 * until PRINT_MOCK_SHIP_AFTER_SECONDS (default 600) have passed, then
 * "shipped" with a FedEx tracking number. Checked before the synth rule above.
 */
const MOCK_CREATED_ORDER = /^mock-gelato-api-(\d{10})-(.+)$/;

function mockShipAfterSeconds(): number {
  const raw = Number(process.env.PRINT_MOCK_SHIP_AFTER_SECONDS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 600;
}

export function mockGelatoCreateOrder(payload: GelatoCreateOrderPayload, now = new Date()): GelatoCreateOrderResponse {
  const epoch = Math.floor(now.getTime() / 1000);
  const id = `mock-gelato-api-${epoch}-${payload.orderReferenceId}`;
  const products = payload.items.reduce((sum, item) => sum + item.quantity * 24, 0);
  return {
    ...createdMockOrder(id, now)!,
    orderType: payload.orderType,
    receipts: [
      {
        currency: payload.currency,
        productsPriceInitial: products,
        shippingPriceInitial: 7.5,
        totalInclVat: Math.round((products + 7.5) * 100) / 100,
      },
    ],
  };
}

function createdMockOrder(id: string, now = new Date()): GelatoOrder | null {
  const m = id.match(MOCK_CREATED_ORDER);
  if (!m) return null;
  const createdAt = new Date(Number(m[1]) * 1000);
  const shipped = (now.getTime() - createdAt.getTime()) / 1000 >= mockShipAfterSeconds();
  const status: GelatoOrder["fulfillmentStatus"] = shipped ? "shipped" : "created";
  const tracking = `7${m[1]}`;
  return {
    id,
    orderType: "order",
    orderReferenceId: m[2],
    fulfillmentStatus: status,
    createdAt: createdAt.toISOString(),
    updatedAt: now.toISOString(),
    items: [
      {
        id: "item-1",
        itemReferenceId: "1",
        fulfillmentStatus: status,
        ...(shipped
          ? {
              fulfillments: [
                {
                  trackingCode: tracking,
                  trackingUrl: `https://www.fedex.com/fedextrack/?trknbr=${tracking}`,
                  shipmentMethodName: "FedEx Ground",
                  shipmentMethodUid: "fedex_ground",
                  fulfillmentCountry: "US",
                  fulfillmentStateProvince: null,
                  fulfillmentFacilityId: null,
                },
              ],
            }
          : {}),
      },
    ],
  };
}
