import type { LumaCreateOrderPayload, LumaCreateOrderResponse, LumaOrder, LumaShipmentsResponse } from "./types";

/**
 * PRINT_PROVIDER_MOCK=1 fixtures, keyed by externalId (our platform order
 * number/name - the reference we'd pass if we ever submitted orders over the
 * API; here it stands in for whatever the VA types as the order reference in
 * Luma's dashboard). Mirrors the Gelato fixture set 1:1 so
 * scripts/test-print-reconcile.ts can run the same scenarios against both
 * providers.
 */
export const LUMAPRINTS_ORDER_FIXTURES: LumaOrder[] = [
  {
    orderNumber: "10000000794",
    externalId: "PC-2001",
    storeId: "818",
    orderDate: "2026-09-01T10:00:00.000Z",
    orderStatus: "Shipped",
  },
  {
    orderNumber: "10000000795",
    externalId: "PC-2002",
    storeId: "818",
    orderDate: "2026-09-05T10:00:00.000Z",
    orderStatus: "In Production",
  },
  {
    orderNumber: "10000000796",
    externalId: "PC-2003",
    storeId: "818",
    orderDate: "2026-09-04T10:00:00.000Z",
    orderStatus: "Cancelled",
  },
];

export const LUMAPRINTS_SHIPMENT_FIXTURES: Record<string, LumaShipmentsResponse> = {
  "10000000794": {
    orderNumber: "10000000794",
    shipments: [
      {
        carrier: "FedEx",
        shippingMethod: "FedEx Ground",
        trackingNumber: "392964503590",
        shipmentDate: "2026-09-03",
        shipmentItems: [{ externalItemId: "1", product: "8x10 0.75in Stretched Canvas", quantity: 1 }],
      },
    ],
  },
};

/** Same synthesis rule as Gelato's (see gelato/fixtures.ts): mock order numbers always resolve. */
export function synthesizeLumaOrder(externalId: string): LumaOrder | null {
  const m = externalId.match(/^([A-Z]{2})-?(\d{4,})$/);
  if (!m) return null;
  const n = Number(m[2]);
  // Only the mock shops' own numbering (lib/mock/data.ts starts at 32000):
  // anything else stays unknown so a real "missing at the provider" case
  // still surfaces as missing.
  if (n < 32000) return null;
  const last = n % 10;
  return {
    orderNumber: `1000${String(n).padStart(7, "0")}`,
    externalId,
    storeId: "818",
    orderDate: new Date(Date.now() - (6 + (n % 5)) * 60 * 60 * 1000).toISOString(),
    orderStatus: last <= 6 ? "Shipped" : last <= 8 ? "In Production" : "Received",
  };
}

export function lumaShipmentsFor(orderNumber: string): LumaShipmentsResponse | null {
  const fixed = LUMAPRINTS_SHIPMENT_FIXTURES[orderNumber];
  if (fixed) return fixed;
  const created = createdMockShipments(orderNumber);
  if (created) return created;
  const m = orderNumber.match(/^1000(\d{7})$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (n % 10 > 6) return { orderNumber, shipments: [] };
  const tracking = `1Z999AA1${String(n).padStart(10, "0")}`;
  return {
    orderNumber,
    shipments: [
      {
        carrier: "UPS",
        shippingMethod: "UPS Ground",
        trackingNumber: tracking,
        shipmentDate: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
        shipmentItems: [{ externalItemId: "1", product: "8x10 Fine Art Paper Print", quantity: 1 }],
      },
    ],
  };
}

export function findLumaFixtureByExternalId(externalId: string): LumaOrder | null {
  return LUMAPRINTS_ORDER_FIXTURES.find((o) => o.externalId === externalId) ?? synthesizeLumaOrder(externalId);
}

export function findLumaFixtureByOrderNumber(orderNumber: string): LumaOrder | null {
  const fixed = LUMAPRINTS_ORDER_FIXTURES.find((o) => o.orderNumber === orderNumber);
  if (fixed) return fixed;
  const created = createdMockOrder(orderNumber);
  if (created) return created;
  const m = orderNumber.match(/^1000(\d{7})$/);
  return m ? synthesizeLumaOrder(`PC${Number(m[1])}`) : null;
}

/**
 * Orders created through the mock createOrder (one-tap submit). The order
 * number is "9" + the creation time in epoch seconds, so any later process
 * (cron reconcile, the order page) can answer getOrder without shared state:
 * it stays "Awaiting Fulfillment" until PRINT_MOCK_SHIP_AFTER_SECONDS
 * (default 600) have passed, then reads as Shipped with a UPS tracking number.
 */
const MOCK_CREATED_ORDER = /^9(\d{10})$/;

export function mockShipAfterSeconds(): number {
  const raw = Number(process.env.PRINT_MOCK_SHIP_AFTER_SECONDS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 600;
}

export function mockLumaCreateOrder(payload: LumaCreateOrderPayload, now = new Date()): LumaCreateOrderResponse {
  const orderNumber = `9${Math.floor(now.getTime() / 1000)}`;
  const orderTotal = Math.round(payload.orderItems.reduce((sum, item) => sum + item.quantity * (item.width * item.height * 0.18 + 6), 0) * 100) / 100;
  return { orderNumber, externalId: payload.externalId, orderStatus: "Awaiting Fulfillment", orderTotal };
}

function createdMockAgeSeconds(orderNumber: string): number | null {
  const m = orderNumber.match(MOCK_CREATED_ORDER);
  return m ? Date.now() / 1000 - Number(m[1]) : null;
}

function createdMockOrder(orderNumber: string): LumaOrder | null {
  const age = createdMockAgeSeconds(orderNumber);
  if (age === null) return null;
  const shipped = age >= mockShipAfterSeconds();
  return {
    orderNumber,
    externalId: null, // not encoded in the number; reconcile keeps the stored reference
    storeId: "818",
    orderDate: new Date(Number(orderNumber.slice(1)) * 1000).toISOString(),
    orderStatus: shipped ? "Shipped" : "Awaiting Fulfillment",
  };
}

function createdMockShipments(orderNumber: string): LumaShipmentsResponse | null {
  const age = createdMockAgeSeconds(orderNumber);
  if (age === null) return null;
  if (age < mockShipAfterSeconds()) return { orderNumber, shipments: [] };
  const tracking = `1Z999AA9${orderNumber.slice(1)}`;
  return {
    orderNumber,
    shipments: [
      {
        carrier: "UPS",
        shippingMethod: "UPS Ground",
        trackingNumber: tracking,
        shipmentDate: new Date().toISOString(),
        shipmentItems: [{ externalItemId: "1", product: "Mock print", quantity: 1 }],
      },
    ],
  };
}
