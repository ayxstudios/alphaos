export const GELATO_ORDER_BASE = "https://order.gelatoapis.com";

/** Credentials shape stored (encrypted) in businesses.print_credentials.gelato. */
export type GelatoCredentials = {
  apiKey: string;
  webhookSecret?: string | null;
};

// Gelato's own fulfillment status words (dashboard.gelato.com/docs/orders/order_details/).
export type GelatoFulfillmentStatus =
  | "created"
  | "passed"
  | "failed"
  | "canceled"
  | "printed"
  | "shipped"
  | "delivered";

export type GelatoFulfillment = {
  trackingCode: string;
  trackingUrl: string | null;
  shipmentMethodName: string | null;
  shipmentMethodUid: string | null;
  fulfillmentCountry: string | null;
  fulfillmentStateProvince: string | null;
  fulfillmentFacilityId: string | null;
};

export type GelatoOrderItem = {
  id: string;
  itemReferenceId: string | null;
  fulfillmentStatus: GelatoFulfillmentStatus;
  fulfillments?: GelatoFulfillment[];
};

export type GelatoOrder = {
  id: string;
  orderType?: string;
  orderReferenceId: string | null;
  customerReferenceId?: string | null;
  fulfillmentStatus: GelatoFulfillmentStatus;
  financialStatus?: string;
  channel?: string;
  storeId?: string | null;
  createdAt?: string;
  updatedAt?: string;
  orderedAt?: string;
  items: GelatoOrderItem[];
};

export type GelatoSearchResponse = {
  orders: GelatoOrder[];
};

// order_status_updated webhook (dashboard.gelato.com/docs/webhooks/). Sent per
// order; items carry per-item status + tracking.
export type GelatoWebhookEvent = {
  id: string;
  event: "order_status_updated" | "order_item_track_and_trace";
  orderId: string;
  storeId: string | null;
  orderReferenceId: string | null;
  fulfillmentStatus: GelatoFulfillmentStatus;
  items: GelatoOrderItem[];
};
