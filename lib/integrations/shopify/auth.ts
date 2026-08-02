import { ShopifyApiError } from "./errors";
import type { ShopifyAuthType, ShopifyCredentials } from "./types";

/**
 * Shopify auth helpers shared by the client, the webhook, and Settings.
 *
 * Two credential shapes coexist (see ShopifyAuthType): 2026+ Dev Dashboard apps
 * authenticate with a Client ID + Secret exchanged for a short-lived token, and
 * legacy custom apps carry a permanent token + a separate webhook secret. These
 * helpers detect which a shop has and pick the right value.
 */

/** Which auth model a shop uses. Explicit `authType` wins; else inferred. */
export function resolveShopifyAuthType(creds: ShopifyCredentials): ShopifyAuthType {
  if (creds.authType) return creds.authType;
  if (creds.clientId && creds.clientSecret) return "client_credentials";
  return "legacy";
}

/**
 * The HMAC key for webhook verification: the client secret for Dev Dashboard
 * apps (it doubles as the signing key), or the dedicated webhook secret for
 * legacy custom apps. Undefined when the shop isn't configured to verify.
 */
export function shopifyWebhookHmacKey(creds: ShopifyCredentials): string | undefined {
  return resolveShopifyAuthType(creds) === "client_credentials"
    ? creds.clientSecret
    : creds.webhookSecret;
}

/** Whether a shop has enough credentials to reach the Admin API. */
export function isShopifyConnected(creds: ShopifyCredentials): boolean {
  if (!creds.shopDomain) return false;
  return resolveShopifyAuthType(creds) === "client_credentials"
    ? !!(creds.clientId && creds.clientSecret)
    : !!creds.accessToken;
}

export type ClientCredentialsToken = {
  accessToken: string;
  scope: string;
  expiresIn: number; // seconds (~86399)
};

/**
 * Exchange a Dev Dashboard app's Client ID + Secret for a short-lived Admin API
 * access token (Shopify's client_credentials grant). The token is returned to
 * the caller to cache; secrets are never included in thrown error messages.
 */
export async function exchangeClientCredentials(
  shopDomain: string,
  clientId: string,
  clientSecret: string,
): Promise<ClientCredentialsToken> {
  const res = await fetch(`https://${shopDomain}/admin/oauth/access_token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    }).toString(),
  });

  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    scope?: string;
    expires_in?: number;
  };
  if (!res.ok || !body.access_token) {
    throw new ShopifyApiError(
      res.status,
      `Shopify client_credentials exchange failed (${res.status})`,
    );
  }
  return {
    accessToken: body.access_token,
    scope: body.scope ?? "",
    expiresIn: Number(body.expires_in ?? 0),
  };
}
