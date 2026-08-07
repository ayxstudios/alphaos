import { ShopifyApiError } from "./errors";
import { ShopifyClient } from "./client";
import type { ShopifyCredentials } from "./types";
import { appUrl } from "@/lib/urls";

export const SHOPIFY_ORDERS_CREATE_TOPIC = "ORDERS_CREATE";

type WebhookNode = {
  id: string;
  topic: string;
  uri?: string | null;
  format?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  endpoint?: { __typename?: string; callbackUrl?: string | null } | null;
};

export type ShopifyWebhookSubscription = {
  id: string;
  topic: string;
  uri: string | null;
  format: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type ShopifyWebhookStatus = {
  expectedUrl: string;
  registered: boolean;
  pointingCorrectly: boolean;
  subscriptions: ShopifyWebhookSubscription[];
  error?: string;
};

export type ShopifyWebhookRegistrationResult = ShopifyWebhookStatus & {
  action: "already_registered" | "created";
};

const WEBHOOKS_QUERY = `
query {
  webhookSubscriptions(first: 100) {
    nodes {
      id
      topic
      uri
      format
      createdAt
      updatedAt
      endpoint {
        __typename
        ... on WebhookHttpEndpoint { callbackUrl }
      }
    }
  }
}`;

const WEBHOOK_CREATE_MUTATION = `
mutation($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
  webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
    userErrors { field message }
    webhookSubscription {
      id
      topic
      uri
      format
      createdAt
      updatedAt
    }
  }
}`;

function endpointUri(node: WebhookNode): string | null {
  return node.uri ?? node.endpoint?.callbackUrl ?? null;
}

function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

export function shopifyOrdersCreateWebhookUrl(): string {
  const configured = process.env.SHOPIFY_WEBHOOK_URL;
  return configured?.trim() || appUrl("/api/shopify/webhook");
}

export async function getShopifyOrdersCreateWebhookStatus(
  shopId: string,
  creds: ShopifyCredentials,
  expectedUrl = shopifyOrdersCreateWebhookUrl(),
): Promise<ShopifyWebhookStatus> {
  const client = new ShopifyClient(shopId, creds);
  const data = await client.graphql<{ webhookSubscriptions: { nodes: WebhookNode[] } }>(WEBHOOKS_QUERY);
  const expected = normalizeUrl(expectedUrl);
  const subscriptions = data.webhookSubscriptions.nodes
    .filter((node) => node.topic === SHOPIFY_ORDERS_CREATE_TOPIC)
    .map((node) => ({
      id: node.id,
      topic: node.topic,
      uri: endpointUri(node),
      format: node.format ?? null,
      createdAt: node.createdAt ?? null,
      updatedAt: node.updatedAt ?? null,
    }));
  const pointingCorrectly = subscriptions.some((sub) => sub.uri && normalizeUrl(sub.uri) === expected);
  return {
    expectedUrl,
    registered: subscriptions.length > 0,
    pointingCorrectly,
    subscriptions,
  };
}

export async function ensureShopifyOrdersCreateWebhook(
  shopId: string,
  creds: ShopifyCredentials,
  expectedUrl = shopifyOrdersCreateWebhookUrl(),
): Promise<ShopifyWebhookRegistrationResult> {
  const status = await getShopifyOrdersCreateWebhookStatus(shopId, creds, expectedUrl);
  if (status.pointingCorrectly) return { ...status, action: "already_registered" };

  const client = new ShopifyClient(shopId, creds);
  const data = await client.graphql<{
    webhookSubscriptionCreate: {
      userErrors: { field?: string[]; message: string }[];
      webhookSubscription: WebhookNode | null;
    };
  }>(WEBHOOK_CREATE_MUTATION, {
    topic: SHOPIFY_ORDERS_CREATE_TOPIC,
    webhookSubscription: {
      uri: expectedUrl,
      format: "JSON",
    },
  });

  const errors = data.webhookSubscriptionCreate.userErrors;
  if (errors.length) {
    throw new ShopifyApiError(
      200,
      `Shopify webhook registration failed: ${errors.map((e) => e.message).join("; ")}`,
    );
  }

  const next = await getShopifyOrdersCreateWebhookStatus(shopId, creds, expectedUrl);
  return { ...next, action: "created" };
}
