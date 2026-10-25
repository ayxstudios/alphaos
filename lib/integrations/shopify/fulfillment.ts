import { ShopifyClient } from "./client";
import { ShopifyApiError } from "./errors";
import type { ShopifyCredentials } from "./types";

type UserError = {
  field: string[] | null;
  message: string;
};

type FulfillmentOrderNode = {
  id: string;
  status: string;
  requestStatus: string;
  supportedActions: { action: string }[];
};

type OrderFulfillmentData = {
  order: {
    id: string;
    name: string | null;
    fulfillmentOrders: {
      nodes: FulfillmentOrderNode[];
    };
  } | null;
};

type FulfillmentCreateData = {
  fulfillmentCreate: {
    fulfillment: { id: string; status: string } | null;
    userErrors: UserError[];
  };
};

type OrderCloseData = {
  orderClose: {
    order: { id: string } | null;
    userErrors: UserError[];
  };
};

export type ShopifyFulfillmentResult = {
  fulfillmentId: string;
  fulfillmentStatus: string;
  closed: boolean;
  closeWarning: string | null;
};

export type ShopifyTrackingInput = {
  trackingNumber: string;
  trackingCompany?: string;
  trackingUrl?: string;
  /** Every parcel of a split print (lib/print/parts.ts); more than one is sent as Shopify's numbers/urls. */
  trackingNumbers?: string[];
  trackingUrls?: string[];
  notifyCustomer?: boolean;
  closeOrder?: boolean;
};

type FulfillmentTrackingInfoUpdateData = {
  fulfillmentTrackingInfoUpdate: {
    fulfillment: { id: string; status: string } | null;
    userErrors: UserError[];
  };
};

const ORDER_FULFILLMENT_QUERY = `
query($id: ID!) {
  order(id: $id) {
    id
    name
    fulfillmentOrders(first: 25) {
      nodes {
        id
        status
        requestStatus
        supportedActions {
          action
        }
      }
    }
  }
}`;

const FULFILLMENT_CREATE_MUTATION = `
mutation($fulfillment: FulfillmentInput!, $message: String) {
  fulfillmentCreate(fulfillment: $fulfillment, message: $message) {
    fulfillment {
      id
      status
    }
    userErrors {
      field
      message
    }
  }
}`;

const FULFILLMENT_TRACKING_UPDATE_MUTATION = `
mutation($fulfillmentId: ID!, $trackingInfoInput: FulfillmentTrackingInput!, $notifyCustomer: Boolean) {
  fulfillmentTrackingInfoUpdate(fulfillmentId: $fulfillmentId, trackingInfoInput: $trackingInfoInput, notifyCustomer: $notifyCustomer) {
    fulfillment {
      id
      status
    }
    userErrors {
      field
      message
    }
  }
}`;

const ORDER_CLOSE_MUTATION = `
mutation($input: OrderCloseInput!) {
  orderClose(input: $input) {
    order {
      id
    }
    userErrors {
      field
      message
    }
  }
}`;

function shopifyOrderGid(platformOrderId: string): string {
  return platformOrderId.startsWith("gid://shopify/Order/")
    ? platformOrderId
    : `gid://shopify/Order/${platformOrderId}`;
}

function userErrorMessage(errors: UserError[]): string {
  return errors.map((error) => error.message).join("; ");
}

/** One number = the exact shape sent before; several = Shopify's numbers/urls on the one fulfillment. */
function trackingInfoFor(tracking: ShopifyTrackingInput): Record<string, unknown> {
  const company = tracking.trackingCompany ? { company: tracking.trackingCompany } : {};
  const numbers = tracking.trackingNumbers?.filter(Boolean) ?? [];
  if (numbers.length > 1) {
    const urls = tracking.trackingUrls?.filter(Boolean) ?? [];
    return { numbers, ...company, ...(urls.length ? { urls } : {}) };
  }
  return {
    number: numbers[0] ?? tracking.trackingNumber,
    ...company,
    ...(tracking.trackingUrl ? { url: tracking.trackingUrl } : {}),
  };
}

function canCreateFulfillment(order: FulfillmentOrderNode): boolean {
  return order.supportedActions.some(
    (action) => action.action.toUpperCase() === "CREATE_FULFILLMENT",
  );
}

export async function fulfillShopifyOrderWithTracking(
  shopId: string,
  platformOrderId: string,
  creds: ShopifyCredentials,
  tracking: ShopifyTrackingInput,
): Promise<ShopifyFulfillmentResult> {
  const client = new ShopifyClient(shopId, creds);
  const orderGid = shopifyOrderGid(platformOrderId);
  const orderData = await client.graphql<OrderFulfillmentData>(ORDER_FULFILLMENT_QUERY, {
    id: orderGid,
  });

  const order = orderData.order;
  if (!order) {
    throw new ShopifyApiError(404, "Shopify order not found.");
  }

  const fulfillmentOrders = order.fulfillmentOrders.nodes.filter(canCreateFulfillment);
  if (!fulfillmentOrders.length) {
    throw new ShopifyApiError(
      422,
      "Shopify has no fulfillable fulfillment orders for this order. It may already be fulfilled, cancelled, on hold, or the app may be missing fulfillment-order scopes.",
    );
  }

  const fulfillmentData = await client.graphql<FulfillmentCreateData>(
    FULFILLMENT_CREATE_MUTATION,
    {
      fulfillment: {
        lineItemsByFulfillmentOrder: fulfillmentOrders.map((fulfillmentOrder) => ({
          fulfillmentOrderId: fulfillmentOrder.id,
        })),
        notifyCustomer: tracking.notifyCustomer ?? true,
        trackingInfo: trackingInfoFor(tracking),
      },
      message: "Fulfilled from AlphaOS",
    },
  );

  const createPayload = fulfillmentData.fulfillmentCreate;
  if (createPayload.userErrors.length || !createPayload.fulfillment) {
    throw new ShopifyApiError(
      422,
      `Shopify fulfillment failed: ${userErrorMessage(createPayload.userErrors) || "No fulfillment was created."}`,
    );
  }

  let closed = false;
  let closeWarning: string | null = null;
  if (tracking.closeOrder) {
    const closeData = await client
      .graphql<OrderCloseData>(ORDER_CLOSE_MUTATION, { input: { id: order.id } })
      .catch((error) => {
        closeWarning = error instanceof Error ? error.message : String(error);
        return null;
      });

    if (closeData) {
      const closePayload = closeData.orderClose;
      if (closePayload.userErrors.length || !closePayload.order) {
        closeWarning = userErrorMessage(closePayload.userErrors) || "Shopify did not close the order.";
      } else {
        closed = true;
      }
    }
  }

  return {
    fulfillmentId: createPayload.fulfillment.id,
    fulfillmentStatus: createPayload.fulfillment.status,
    closed,
    closeWarning,
  };
}

/**
 * Replace the tracking on a fulfillment already made: a later parcel of a split print, after the first was
 * written back on its own (lib/print/tracking.ts). Pass every number the order has, not only the new one.
 */
export async function updateShopifyFulfillmentTracking(
  shopId: string,
  fulfillmentId: string,
  creds: ShopifyCredentials,
  tracking: ShopifyTrackingInput,
): Promise<ShopifyFulfillmentResult> {
  const client = new ShopifyClient(shopId, creds);
  const data = await client.graphql<FulfillmentTrackingInfoUpdateData>(FULFILLMENT_TRACKING_UPDATE_MUTATION, {
    fulfillmentId,
    trackingInfoInput: trackingInfoFor(tracking),
    notifyCustomer: tracking.notifyCustomer ?? true,
  });
  const payload = data.fulfillmentTrackingInfoUpdate;
  if (payload.userErrors.length || !payload.fulfillment) {
    throw new ShopifyApiError(
      422,
      `Shopify tracking update failed: ${userErrorMessage(payload.userErrors) || "No fulfillment was updated."}`,
    );
  }
  return { fulfillmentId: payload.fulfillment.id, fulfillmentStatus: payload.fulfillment.status, closed: false, closeWarning: null };
}
