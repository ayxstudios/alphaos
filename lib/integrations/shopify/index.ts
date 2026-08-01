// Shopify Admin API (GraphQL) integration.
//
// - client.ts    cost-based-throttle GraphQL client + verifyShopifyToken
// - orders.ts    syncShopOrders + importShopifyOrder (shared by webhook + sync)
// - webhook.ts   HMAC verification + orders/create payload normalization
// - figures.ts   figure_count resolution via the shared resolver

export { ShopifyClient, verifyShopifyToken } from "./client";
export {
  syncShopOrders,
  importShopifyOrder,
  normalizeGraphqlOrder,
  type SyncSummary,
  type ShopContext,
  type NormalizedOrder,
} from "./orders";
export { verifyShopifyHmac, normalizeWebhookOrder, type ShopifyWebhookOrder } from "./webhook";
export { resolveFigureCount } from "./figures";
export { ShopifyApiError } from "./errors";
export {
  SHOPIFY_SCOPES,
  SHOPIFY_API_VERSION,
  type ShopifyCredentials,
  type ShopifyIntegrationConfig,
  type FigureRule,
} from "./types";
