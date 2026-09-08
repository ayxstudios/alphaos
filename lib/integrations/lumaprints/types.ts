export const LUMAPRINTS_BASE = {
  sandbox: "https://us.api-sandbox.lumaprints.com",
  production: "https://us.api.lumaprints.com",
} as const;

/** Credentials shape stored (encrypted) in businesses.print_credentials.lumaprints. */
export type LumaPrintsCredentials = {
  username: string; // HTTP Basic auth username (provided after registration)
  password: string; // HTTP Basic auth password
  storeId: string; // required on every order/search call
  sandbox?: boolean; // default false -> production base URL
};

export type LumaOrderStatus =
  | "Awaiting Fulfillment"
  | "In Production"
  | "Shipped"
  | "Cancelled"
  | "On Hold"
  | string; // Luma's docs show only "Awaiting Fulfillment" as an example; treat
  // anything else as an opaque pass-through status rather than fail closed.

export type LumaRecipient = {
  firstName: string;
  lastName: string;
  company?: string | null;
  addressLine1: string;
  addressLine2?: string | null;
  city: string;
  state: string;
  zipCode: string;
  country: string;
  phone?: string | null;
};

export type LumaOrder = {
  orderNumber: string;
  externalId: string | null;
  storeId: string;
  orderDate: string;
  orderStatus: LumaOrderStatus;
  orderTotal?: number;
  recipient?: LumaRecipient;
  orderItems?: Array<{ subcategoryId: number; externalItemId?: string; itemCostTotal?: number }>;
};

export type LumaOrdersPage = {
  orders: LumaOrder[];
  totalOrders: number;
  currentPage: number;
  totalPages: number;
};

export type LumaShipmentItem = {
  externalItemId: string;
  product: string;
  quantity: number;
};

export type LumaShipment = {
  carrier: string;
  shippingMethod: string;
  trackingNumber: string;
  shipmentDate: string;
  shipmentItems: LumaShipmentItem[];
};

export type LumaShipmentsResponse = {
  orderNumber: number | string;
  shipments: LumaShipment[];
};

// The one documented webhook event ("shipping"), configured through Luma's own
// dashboard (dashboard.lumaprints.com/developer/webhook) - not something our
// app registers over the API. Kept here for the normalizer; there is no
// app/api/webhooks/lumaprints route in this build (see README.md).
export type LumaShippingWebhookPayload = {
  orderNumber: string;
  externalId: string;
  shipments: LumaShipment[];
};
