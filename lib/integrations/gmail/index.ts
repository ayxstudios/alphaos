// Per-business Gmail integration (Google Workspace, Internal user type).
//
// - oauth.ts     Google OAuth (authorize URL, token exchange/refresh, signed state)
// - client.ts    GmailClient: token refresh, send, history/message reads, logging
// - mime.ts      RFC 2822 MIME builder + inbound body/header parsing
// - inbound.ts   pollMailbox / pollAllMailboxes: attach replies to orders
//
// Each business has its OWN Google Cloud project + OAuth client; the client
// id/secret + refresh token are encrypted per business (see
// getBusinessGmailCredentials in lib/db/credentials.ts). Sends go through the
// Gmail API from the business's own orders@ mailbox — never SMTP.

export { GmailClient, markGmailConnected } from "./client";
export {
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  refreshAccessToken,
  signOAuthState,
  verifyOAuthState,
  newState,
} from "./oauth";
export { buildRawMessage, textToHtml } from "./mime";
export {
  pollMailbox,
  pollAllMailboxes,
  pollMailboxesScheduled,
  type InboundSummary,
  type PollBatchResult,
} from "./inbound";
export {
  GmailApiError,
  GmailReauthRequiredError,
  GmailNotConnectedError,
} from "./errors";
export {
  GMAIL_SCOPES,
  type GmailCredentials,
  type GmailProfile,
} from "./types";
