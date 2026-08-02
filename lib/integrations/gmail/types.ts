/** Shapes for the per-business Gmail integration + Google OAuth subset. */

// Least-privilege scopes: send customer email, and read history/messages so the
// inbound poller can attach replies. `gmail.readonly` covers history + get.
export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
] as const;

export const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1";

/**
 * The encrypted per-business Gmail credential blob (businesses.gmail_credentials).
 * Each business has its OWN Google Cloud project + OAuth client, so the client
 * id/secret live here alongside the tokens. Access tokens are short-lived and
 * refreshed on demand; the refresh token is the durable secret.
 */
export type GmailCredentials = {
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  accessToken?: string;
  accessTokenExpiresAt?: string; // ISO
  // The mailbox we send from (e.g. orders@business.com). Mirrored to the
  // non-secret businesses.gmail_address column for display.
  address?: string;
  status?: "connected" | "needs_reauth";
  connectedAt?: string; // ISO
};

export type GoogleTokenResponse = {
  access_token: string;
  expires_in: number; // seconds (~3600)
  refresh_token?: string; // only on the first consent (access_type=offline)
  scope: string;
  token_type: string;
};

/** users.messages.send response. */
export type GmailSendResponse = {
  id: string;
  threadId: string;
};

/** users.getProfile response (subset). */
export type GmailProfile = {
  emailAddress: string;
  historyId: string;
};

/* --- history.list (inbound polling) ------------------------------------- */
export type GmailHistoryResponse = {
  history?: { messagesAdded?: { message: GmailHistoryMessage }[] }[];
  historyId?: string;
  nextPageToken?: string;
};

export type GmailHistoryMessage = {
  id: string;
  threadId: string;
  labelIds?: string[];
};

/** users.messages.get (format=full or metadata) subset. */
export type GmailMessage = {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string; // epoch ms as string
  payload?: GmailPayload;
};

export type GmailPayload = {
  headers?: { name: string; value: string }[];
  mimeType?: string;
  body?: { data?: string; size?: number };
  parts?: GmailPayload[];
};
