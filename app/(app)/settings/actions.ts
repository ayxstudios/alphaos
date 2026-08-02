"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { withUserContext, type RequestUser } from "@/lib/db";
import {
  getShopCredentials,
  setShopCredentials,
  getBusinessGmailCredentials,
  setBusinessGmailCredentials,
} from "@/lib/db/credentials";
import { shops, businesses, emailTemplates } from "@/lib/db/schema";
import type { GmailCredentials } from "@/lib/integrations/gmail";
import { pollMailbox, type InboundSummary } from "@/lib/integrations/gmail";
import { DEFAULT_TEMPLATES, type TemplateKey } from "@/lib/email/templates";
import {
  syncShopReceipts,
  type SyncSummary,
  type EtsyCredentials,
} from "@/lib/integrations/etsy";
import {
  syncShopOrders,
  verifyShopifyToken,
  type SyncSummary as ShopifySyncSummary,
  type ShopifyCredentials,
} from "@/lib/integrations/shopify";

function normalizeDomain(input: string): string {
  return input.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "").toLowerCase();
}

async function requireAdmin(): Promise<RequestUser> {
  const session = await auth();
  if (session?.user?.role !== "admin") throw new Error("Forbidden");
  return { id: session.user.id, role: "admin" };
}

/** Save a shop's Etsy app credentials (keystring + shared secret). Form action. */
export async function saveEtsyCredentials(formData: FormData): Promise<void> {
  const user = await requireAdmin();
  const shopId = String(formData.get("shopId") ?? "");
  const keystring = String(formData.get("keystring") ?? "").trim();
  const sharedSecret = String(formData.get("sharedSecret") ?? "").trim();
  if (!shopId || !keystring || !sharedSecret) throw new Error("Missing fields");

  await withUserContext(user, async (tx) => {
    const creds = (await getShopCredentials(tx, shopId)) as EtsyCredentials;
    await setShopCredentials(tx, shopId, { ...creds, keystring, sharedSecret });
  });
  revalidatePath("/settings");
}

export async function triggerSync(shopId: string): Promise<SyncSummary> {
  await requireAdmin();
  const summary = await syncShopReceipts(shopId);
  revalidatePath("/settings");
  return summary;
}

/* --- Shopify ------------------------------------------------------------ */

/** Verify an Admin API token without saving it. */
export async function testShopifyConnection(
  domain: string,
  token: string,
): Promise<{ ok: boolean; message: string }> {
  await requireAdmin();
  const d = normalizeDomain(domain);
  if (!d || !token.trim()) return { ok: false, message: "Enter a store domain and access token." };
  const result = await verifyShopifyToken(d, token.trim());
  return result.ok
    ? { ok: true, message: `Connected to "${result.shopName}".` }
    : { ok: false, message: result.error };
}

/** Save a shop's Shopify credentials (domain + token + webhook secret). Form action. */
export async function saveShopifyCredentials(formData: FormData): Promise<void> {
  const user = await requireAdmin();
  const shopId = String(formData.get("shopId") ?? "");
  const shopDomain = normalizeDomain(String(formData.get("shopDomain") ?? ""));
  const accessToken = String(formData.get("accessToken") ?? "").trim();
  const webhookSecret = String(formData.get("webhookSecret") ?? "").trim();
  if (!shopId || !shopDomain || !accessToken || !webhookSecret) {
    throw new Error("Missing fields");
  }

  await withUserContext(user, async (tx) => {
    const creds = (await getShopCredentials(tx, shopId)) as ShopifyCredentials;
    await setShopCredentials(tx, shopId, {
      ...creds,
      shopDomain,
      accessToken,
      webhookSecret,
      status: "connected",
    });
    // Keep external_shop_id aligned with the domain so the webhook can find it.
    await tx.update(shops).set({ externalShopId: shopDomain }).where(eq(shops.id, shopId));
  });
  revalidatePath("/settings");
}

export async function triggerShopifySync(shopId: string): Promise<ShopifySyncSummary> {
  await requireAdmin();
  const summary = await syncShopOrders(shopId);
  revalidatePath("/settings");
  return summary;
}

/* --- Gmail (per business) ----------------------------------------------- */

/**
 * Save a business's Gmail OAuth client id/secret + sending address. Preserves an
 * existing refresh token and secret (secret field left blank = keep current), so
 * editing the address doesn't drop a live connection.
 */
export async function saveGmailClient(formData: FormData): Promise<void> {
  const user = await requireAdmin();
  const businessId = String(formData.get("businessId") ?? "");
  const clientId = String(formData.get("clientId") ?? "").trim();
  const clientSecret = String(formData.get("clientSecret") ?? "").trim();
  const address = String(formData.get("address") ?? "").trim().toLowerCase();
  if (!businessId || !clientId || !address) throw new Error("Missing fields");

  await withUserContext(user, async (tx) => {
    const creds = ((await getBusinessGmailCredentials(tx, businessId)) as GmailCredentials | null) ?? {};
    const nextSecret = clientSecret || creds.clientSecret;
    if (!nextSecret) throw new Error("Client secret is required");
    await setBusinessGmailCredentials(tx, businessId, {
      ...creds,
      clientId,
      clientSecret: nextSecret,
      address,
    });
    await tx.update(businesses).set({ gmailAddress: address }).where(eq(businesses.id, businessId));
  });
  revalidatePath("/settings");
}

/** Manually run the inbound reply poller for one business (admin test hook). */
export async function triggerGmailPoll(businessId: string): Promise<InboundSummary> {
  await requireAdmin();
  const summary = await pollMailbox(businessId);
  revalidatePath("/settings");
  return summary;
}

/* --- Email templates (per business) ------------------------------------- */

function assertTemplateKey(key: string): TemplateKey {
  if (key in DEFAULT_TEMPLATES) return key as TemplateKey;
  throw new Error(`Unknown template key: ${key}`);
}

/** Upsert a business's override for one template. */
export async function saveEmailTemplate(formData: FormData): Promise<void> {
  const user = await requireAdmin();
  const businessId = String(formData.get("businessId") ?? "");
  const key = assertTemplateKey(String(formData.get("key") ?? ""));
  const subject = String(formData.get("subject") ?? "").trim();
  const body = String(formData.get("body") ?? "").trim();
  if (!businessId || !subject || !body) throw new Error("Subject and body are required");

  await withUserContext(user, (tx) =>
    tx
      .insert(emailTemplates)
      .values({ businessId, key, subject, body, updatedBy: user.id })
      .onConflictDoUpdate({
        target: [emailTemplates.businessId, emailTemplates.key],
        set: { subject, body, updatedBy: user.id, updatedAt: new Date() },
      }),
  );
  revalidatePath("/settings");
}

/** Remove a business's override, reverting the template to the built-in default. */
export async function resetEmailTemplate(businessId: string, key: string): Promise<void> {
  const user = await requireAdmin();
  const templateKey = assertTemplateKey(key);
  await withUserContext(user, (tx) =>
    tx
      .delete(emailTemplates)
      .where(and(eq(emailTemplates.businessId, businessId), eq(emailTemplates.key, templateKey))),
  );
  revalidatePath("/settings");
}
