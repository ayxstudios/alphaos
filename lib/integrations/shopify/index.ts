// Shopify Admin API (GraphQL) integration.
//
// - client.ts    cost-based-throttle GraphQL client + verifyShopifyToken
// - orders.ts    syncShopOrders + importShopifyOrder (shared by webhook + sync)
// - webhook.ts   HMAC verification + orders/create payload normalization
// - figures.ts   figure_count resolution via the shared resolver

export { ShopifyClient, verifyShopifyToken, verifyShopifyClientCredentials } from "./client";
export {
  resolveShopifyAuthType,
  shopifyWebhookHmacKey,
  isShopifyConnected,
  exchangeClientCredentials,
} from "./auth";
export {
  syncShopOrders,
  importShopifyOrder,
  normalizeGraphqlOrder,
  fetchShopifyOrder,
  resolveWebhookOrder,
  type SyncSummary,
  type ShopContext,
  type NormalizedOrder,
  type GraphqlRunner,
} from "./orders";
export { verifyShopifyHmac, normalizeWebhookOrder, type ShopifyWebhookOrder } from "./webhook";
export { resolveFigureCount } from "./figures";
export { ShopifyApiError } from "./errors";
export {
  SHOPIFY_SCOPES,
  SHOPIFY_API_VERSION,
  type ShopifyCredentials,
  type ShopifyAuthType,
  type ShopifyIntegrationConfig,
  type FigureRule,
} from "./types";
