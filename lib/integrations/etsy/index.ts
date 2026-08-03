// Etsy Open API v3 integration.
//
// - client.ts    rate-limited fetch, backoff, token refresh, logging
// - oauth.ts     PKCE + token exchange + signed state cookie
// - receipts.ts  syncShopReceipts: pull receipts -> orders/order_items
// - figures.ts   figure_count resolution (shop rules -> opt-in heuristic -> unresolved)

export { EtsyClient } from "./client";
export { syncShopReceipts, getShopReceipts, type SyncSummary } from "./receipts";
export { resolveFigureCount, resolveStyle } from "./figures";
export {
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  refreshTokens,
  generateCodeVerifier,
  codeChallenge,
  signOAuthState,
  verifyOAuthState,
  newState,
} from "./oauth";
export { ReauthRequiredError, EtsyApiError } from "./errors";
export {
  ETSY_SCOPES,
  type EtsyCredentials,
  type EtsyIntegrationConfig,
  type FigureRule,
  type StyleRule,
} from "./types";
