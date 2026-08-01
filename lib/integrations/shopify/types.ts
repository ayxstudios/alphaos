import type { FigureRule } from "../figures";

export type { FigureRule };

// Admin GraphQL API version (2025-01 or later).
export const SHOPIFY_API_VERSION = "2025-01";

/** Admin API access scopes the custom app requires. */
export const SHOPIFY_SCOPES = [
  "read_orders", // orders, line items, line-item properties, variant options
  "read_customers", // buyer email + name
] as const;

/** Encrypted per-shop credential blob (shops.credentials). */
export type ShopifyCredentials = {
  shopDomain?: string; // e.g. pixart.myshopify.com
  accessToken?: string; // custom app Admin API token (shpat_...)
  webhookSecret?: string; // custom app API secret key — signs webhook HMAC
  status?: "connected" | "not_connected";
};

/** Non-secret integration config (shops.integration_config). */
export type ShopifyIntegrationConfig = {
  figureRules?: FigureRule[];
  allowHeuristicFigureCount?: boolean; // default false
  syncCursor?: string; // ISO of the newest order createdAt imported
  syncingSince?: string; // ISO; concurrency guard
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
