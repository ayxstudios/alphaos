/** Shapes for the Etsy Open API v3 subset we consume, plus our stored config. */

import type { FigureRule, StyleRule } from "../figures";

export type { FigureRule, StyleRule };

export const ETSY_SCOPES = [
  "transactions_r",
  "transactions_w",
  "email_r",
  "listings_r",
  "shops_r",
] as const;

export const ETSY_API_BASE = "https://api.etsy.com/v3/application";
export const ETSY_TOKEN_URL = "https://api.etsy.com/v3/public/oauth/token";
export const ETSY_AUTHORIZE_URL = "https://www.etsy.com/oauth/connect";

/** The encrypted per-shop credential blob (shops.credentials). */
export type EtsyCredentials = {
  keystring?: string;
  sharedSecret?: string;
  etsyShopId?: string;
  etsyUserId?: string;
  accessToken?: string;
  accessTokenExpiresAt?: string; // ISO
  refreshToken?: string;
  refreshTokenExpiresAt?: string; // ISO (now + 90d on each issue)
  status?: "connected" | "needs_reauth";
};

/** Non-secret integration config (shops.integration_config). */
export type EtsyIntegrationConfig = {
  figureRules?: FigureRule[];
  styleRules?: StyleRule[];
  // Classification (non-portrait) + photo-request behaviour. See lib/integrations/classify.ts.
  nonPortraitSkus?: string[];
  nonPortraitTitles?: string[];
  photoRequestEnabled?: boolean; // default true for Etsy
  allowHeuristicFigureCount?: boolean; // default false
  syncCursor?: string; // ISO of the newest created_timestamp imported
  syncingSince?: string; // ISO; concurrency guard
};

export type EtsyTokenResponse = {
  access_token: string;
  token_type: string;
  expires_in: number; // seconds (3600)
  refresh_token: string;
};

export type EtsyVariation = {
  property_id?: number;
  formatted_name: string;
  formatted_value: string;
};

export type EtsyTransaction = {
  transaction_id: number;
  title: string | null;
  sku: string | null;
  quantity: number;
  is_digital: boolean;
  listing_id: number | null;
  variations: EtsyVariation[];
};

export type EtsyReceipt = {
  receipt_id: number;
  created_timestamp: number; // unix seconds
  name: string | null; // buyer / ship-to name
  buyer_email: string | null; // requires email_r
  transactions: EtsyTransaction[];
};

export type EtsyReceiptsResponse = {
  count: number;
  results: EtsyReceipt[];
};
