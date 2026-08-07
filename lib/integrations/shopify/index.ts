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
  freshShopifyCredentials,
} from "./auth";
export {
  syncShopOrders,
  importShopifyOrder,
  normalizeGraphqlOrder,
  fetchShopifyOrder,
  resolveWebhookOrder,
  resolverInput,
  isAddOnLine,
  type SyncSummary,
  type ShopContext,
  type NormalizedOrder,
  type NormalizedLineItem,
  type GraphqlRunner,
} from "./orders";
export { verifyShopifyHmac, normalizeWebhookOrder, type ShopifyWebhookOrder } from "./webhook";
export {
  ensureShopifyOrdersCreateWebhook,
  getShopifyOrdersCreateWebhookStatus,
  shopifyOrdersCreateWebhookUrl,
  type ShopifyWebhookRegistrationResult,
  type ShopifyWebhookStatus,
} from "./webhooks";
export {
  fetchShopifyOrderProductMedia,
  type ShopifyProductMedia,
} from "./product-media";
export { resolveFigureCount, resolveStyle } from "./figures";
export { ShopifyApiError } from "./errors";
export {
  SHOPIFY_SCOPES,
  SHOPIFY_API_VERSION,
  type ShopifyCredentials,
  type ShopifyAuthType,
  type ShopifyIntegrationConfig,
  type FigureRule,
  type StyleRule,
} from "./types";
