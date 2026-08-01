"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { withUserContext, type RequestUser } from "@/lib/db";
import { getShopCredentials, setShopCredentials } from "@/lib/db/credentials";
import { shops } from "@/lib/db/schema";
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
