export const GELATO_ORDER_BASE = "https://order.gelatoapis.com";

/** Credentials shape stored (encrypted) in businesses.print_credentials.gelato. */
export type GelatoCredentials = {
  apiKey: string;
  webhookSecret?: string | null;
  // Gelato has no separate sandbox host. When true, createOrder sends
  // orderType "draft": the order is stored in the dashboard but never produced.
  sandbox?: boolean;
  // Live account, but every order is created as a draft: it waits in the
  // Gelato dashboard until a person approves it there (the VA print check).
  draftOnly?: boolean;
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

// POST /v4/orders (dashboard.gelato.com/docs/orders/v4/create/). Used by the
// one-tap submit (lib/print/submit.ts); productUid comes from the mapping.
export type GelatoShippingAddress = {
  firstName: string;
  lastName: string;
  companyName?: string | null;
  addressLine1: string;
  addressLine2?: string | null;
  city: string;
  state?: string | null;
  postCode: string;
  country: string;
  email?: string | null;
  phone?: string | null;
};

export type GelatoCreateOrderPayload = {
  orderType: "order" | "draft";
  orderReferenceId: string;
  customerReferenceId: string;
  currency: string;
  shipmentMethodUid?: string;
  items: Array<{
    itemReferenceId: string;
    productUid: string;
    quantity: number;
    files: Array<{ type: "default"; url: string }>;
  }>;
  shippingAddress: GelatoShippingAddress;
};

export type GelatoReceipt = {
  currency: string;
  productsPriceInitial?: number;
  shippingPriceInitial?: number;
  totalInclVat?: number;
};

export type GelatoCreateOrderResponse = GelatoOrder & { receipts?: GelatoReceipt[] };
