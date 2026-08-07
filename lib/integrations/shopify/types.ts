import type { FigureRule, StyleRule } from "../figures";

export type { FigureRule, StyleRule };

// Admin GraphQL API version (2025-01 or later).
export const SHOPIFY_API_VERSION = "2025-01";

/** Admin API access scopes the custom app requires. */
export const SHOPIFY_SCOPES = [
  "read_orders", // orders, line items, line-item properties, variant options
  "write_orders", // close/archive orders after AlphaOS completion
  "read_customers", // buyer email + name
  "read_products", // product/variant thumbnails on Shopify order detail
  "read_merchant_managed_fulfillment_orders", // retrieve fulfillment orders
  "write_merchant_managed_fulfillment_orders", // create fulfillments with tracking
] as const;

/**
 * How a shop authenticates to the Admin API.
 * - "client_credentials": Dev Dashboard apps (Shopify's model from 2026-01-01).
 *   A Client ID + Client Secret are exchanged for a SHORT-LIVED (24h) access
 *   token via the client_credentials grant; the client secret also signs the
 *   webhook HMAC.
 * - "legacy": deprecated admin-created custom apps issuing a PERMANENT shpat_
 *   token plus a separate API secret key for webhook HMAC.
 */
export type ShopifyAuthType = "client_credentials" | "legacy";

/** Encrypted per-shop credential blob (shops.credentials). */
export type ShopifyCredentials = {
  // Undefined on pre-2026 rows → inferred (legacy when a permanent accessToken
  // is present and no clientId; see resolveShopifyAuthType).
  authType?: ShopifyAuthType;
  shopDomain?: string; // e.g. pixart.myshopify.com

  // --- client_credentials ---
  clientId?: string;
  clientSecret?: string; // ALSO the webhook HMAC key
  accessTokenExpiresAt?: string; // ISO; when the cached 24h token lapses

  // --- both models ---
  // Sent in X-Shopify-Access-Token. Legacy: permanent shpat_. client_credentials:
  // a cached token, refreshed on demand before/after expiry.
  accessToken?: string;

  // --- legacy only ---
  webhookSecret?: string; // custom app API secret key — signs webhook HMAC

  status?: "connected" | "not_connected";
};

/** Non-secret integration config (shops.integration_config). */
export type ShopifyIntegrationConfig = {
  figureRules?: FigureRule[];
  styleRules?: StyleRule[];
  // Classification (non-portrait) + photo-request behaviour. See lib/integrations/classify.ts.
  nonPortraitSkus?: string[];
  nonPortraitTitles?: string[];
  photoRequestEnabled?: boolean; // default false for Shopify
  allowHeuristicFigureCount?: boolean; // default false
  syncCursor?: string; // ISO of the newest order createdAt imported
  syncingSince?: string; // ISO; concurrency guard
  lastSyncAt?: string; // ISO; last successful sync completion, not the cursor
};

/* --- GraphQL order query response --------------------------------------- */
export type GqlSelectedOption = { name: string; value: string };
export type GqlAttribute = { key: string; value: string | null };

export type GqlLineItem = {
  sku: string | null;
  title: string | null;
  variantTitle: string | null;
  quantity: number;
  requiresShipping: boolean;
  variant: { selectedOptions: GqlSelectedOption[] } | null;
  customAttributes: GqlAttribute[];
};

export type GqlOrder = {
  id: string;
  name: string | null; // human order number, e.g. "PC31972"
  sourceName: string | null; // "web", "pos", "shopify_draft_order", …
  legacyResourceId: string;
  createdAt: string; // ISO
  email: string | null;
  customer: { firstName: string | null; lastName: string | null; email: string | null } | null;
  lineItems: { nodes: GqlLineItem[] };
};

export type GqlOrdersResponse = {
  orders: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: GqlOrder[];
  };
};

/** Cost-based throttle info Shopify returns in `extensions.cost`. */
export type ThrottleStatus = {
  maximumAvailable: number;
  currentlyAvailable: number;
  restoreRate: number;
};
