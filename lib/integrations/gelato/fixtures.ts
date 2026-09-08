import type { GelatoOrder } from "./types";

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

export function findGelatoFixtureByReference(referenceId: string): GelatoOrder | null {
  return GELATO_FIXTURES[referenceId] ?? null;
}

export function findGelatoFixtureById(id: string): GelatoOrder | null {
  return Object.values(GELATO_FIXTURES).find((order) => order.id === id) ?? null;
}
