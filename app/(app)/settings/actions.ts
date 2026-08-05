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
import { reresolveShop, type ReresolveSummary } from "@/lib/orders/resolution";
import type { FigureRule, StyleRule } from "@/lib/integrations/figures";
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
  verifyShopifyClientCredentials,
  type SyncSummary as ShopifySyncSummary,
  type ShopifyCredentials,
  type ShopifyAuthType,
} from "@/lib/integrations/shopify";

function normalizeDomain(input: string): string {
  return input.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "").toLowerCase();
}

async function requireAdmin(): Promise<RequestUser> {
  const session = await auth();
  if (session?.user?.role !== "admin") throw new Error("Forbidden");
  return { id: session.user.id, role: "admin" };
}

/**
 * Set the portrait styles a shop offers — the catalog designers' styles are
 * chosen from. Trimmed, de-duplicated (case-insensitive). Admin-only (shops RLS
 * is admin-write; settings is an admin surface).
 */
export async function setShopStyles(
  shopId: string,
  raw: string[],
): Promise<{ ok: true } | { ok: false; message: string }> {
  const user = await requireAdmin();
  if (!shopId) return { ok: false, message: "Missing shop" };

  const seen = new Set<string>();
  const styles: string[] = [];
  for (const s of raw) {
    const t = s.trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    styles.push(t);
  }

  await withUserContext(user, (tx) =>
    tx.update(shops).set({ styles: styles.length ? styles : null }).where(eq(shops.id, shopId)),
  );
  // Only revalidate the OTHER route (the styles catalog for the designers page);
  // revalidating "/settings" here would refetch the heavy settings page and undo
  // the optimistic chip edit. Settings is force-dynamic, so it reloads fresh next
  // visit anyway.
  revalidatePath("/designers");
  return { ok: true };
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

/** Backfill an Etsy shop's full history (re-scan from the widened window). */
export async function backfillEtsyShop(shopId: string): Promise<SyncSummary> {
  const user = await requireAdmin();
  await resetCursor(user, shopId);
  const summary = await syncShopReceipts(shopId);
  revalidatePath("/settings");
  return summary;
}

/* --- Shopify ------------------------------------------------------------ */

/**
 * Verify Shopify credentials without saving, for either auth model. Blank secret
 * fields fall back to what's already stored (so "Test" works when the admin is
 * only editing the domain and keeping the saved secret).
 */
export async function testShopifyConnection(input: {
  shopId: string;
  authType: ShopifyAuthType;
  domain: string;
  accessToken?: string;
  clientId?: string;
  clientSecret?: string;
}): Promise<{ ok: boolean; message: string }> {
  const user = await requireAdmin();
  const stored = (await withUserContext(user, (tx) =>
    getShopCredentials(tx, input.shopId),
  )) as ShopifyCredentials;

  const d = normalizeDomain(input.domain || stored.shopDomain || "");
  if (!d) return { ok: false, message: "Enter a store domain." };

  if (input.authType === "client_credentials") {
    const clientId = input.clientId?.trim() || stored.clientId;
    const clientSecret = input.clientSecret?.trim() || stored.clientSecret;
    if (!clientId || !clientSecret) {
      return { ok: false, message: "Enter a Client ID and Client secret." };
    }
    const r = await verifyShopifyClientCredentials(d, clientId, clientSecret);
    return r.ok ? { ok: true, message: `Connected to "${r.shopName}".` } : { ok: false, message: r.error };
  }

  const token = input.accessToken?.trim() || stored.accessToken;
  if (!token) return { ok: false, message: "Enter an access token." };
  const r = await verifyShopifyToken(d, token);
  return r.ok ? { ok: true, message: `Connected to "${r.shopName}".` } : { ok: false, message: r.error };
}

/**
 * Save a shop's Shopify credentials. Two shapes:
 * - client_credentials: domain + Client ID + Client secret (2026 Dev Dashboard).
 * - legacy: domain + permanent access token + webhook secret.
 * Secret fields left blank keep the stored value. Switching auth type clears the
 * other model's fields (and any cached token) so stale credentials never linger.
 */
export async function saveShopifyCredentials(formData: FormData): Promise<void> {
  const user = await requireAdmin();
  const shopId = String(formData.get("shopId") ?? "");
  const authType = (String(formData.get("authType") ?? "client_credentials")) as ShopifyAuthType;
  const shopDomain = normalizeDomain(String(formData.get("shopDomain") ?? ""));
  if (!shopId || !shopDomain) throw new Error("Missing fields");

  await withUserContext(user, async (tx) => {
    const creds = (await getShopCredentials(tx, shopId)) as ShopifyCredentials;

    if (authType === "client_credentials") {
      const clientId = String(formData.get("clientId") ?? "").trim() || creds.clientId;
      const clientSecret = String(formData.get("clientSecret") ?? "").trim() || creds.clientSecret;
      if (!clientId || !clientSecret) throw new Error("Client ID and secret are required");
      await setShopCredentials(tx, shopId, {
        ...creds,
        authType: "client_credentials",
        shopDomain,
        clientId,
        clientSecret,
        // Clear legacy-only fields and any cached token from a prior model.
        accessToken: undefined,
        accessTokenExpiresAt: undefined,
        webhookSecret: undefined,
        status: "connected",
      });
    } else {
      const accessToken = String(formData.get("accessToken") ?? "").trim() || creds.accessToken;
      const webhookSecret = String(formData.get("webhookSecret") ?? "").trim() || creds.webhookSecret;
      if (!accessToken || !webhookSecret) throw new Error("Access token and webhook secret are required");
      await setShopCredentials(tx, shopId, {
        ...creds,
        authType: "legacy",
        shopDomain,
        accessToken,
        webhookSecret,
        clientId: undefined,
        clientSecret: undefined,
        accessTokenExpiresAt: undefined,
        status: "connected",
      });
    }

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

/** Reset a shop's sync cursor and run a full window sync (idempotent). */
async function resetCursor(user: RequestUser, shopId: string): Promise<void> {
  await withUserContext(user, async (tx) => {
    const [s] = await tx.select({ cfg: shops.integrationConfig }).from(shops).where(eq(shops.id, shopId));
    const cfg = (s?.cfg ?? {}) as Record<string, unknown>;
    await tx
      .update(shops)
      .set({ integrationConfig: { ...cfg, syncCursor: undefined, syncingSince: undefined } })
      .where(eq(shops.id, shopId));
  });
}

/**
 * Backfill a Shopify shop's full history: reset the cursor and re-scan, with ALL
 * automated customer email suppressed (a historical import must never message a
 * customer). Imports are idempotent, so re-scanning is safe.
 */
export async function backfillShopifyShop(shopId: string): Promise<ShopifySyncSummary> {
  const user = await requireAdmin();
  await resetCursor(user, shopId);
  const summary = await syncShopOrders(shopId, { suppressCustomerEmail: true });
  revalidatePath("/settings");
  revalidatePath("/orders");
  revalidatePath("/board");
  return summary;
}

/* --- Figure/style resolution rules (per shop, Etsy or Shopify) ----------- */

function sanitizeFigureRules(rules: unknown): FigureRule[] {
  if (!Array.isArray(rules)) return [];
  const out: FigureRule[] = [];
  for (const r of rules) {
    const match = String((r as { match?: unknown })?.match ?? "").trim();
    if (!match) continue;
    const type = (r as { type?: unknown })?.type === "map" ? "map" : "integer";
    if (type === "map") {
      const map: Record<string, number> = {};
      const raw = (r as { map?: unknown })?.map;
      if (raw && typeof raw === "object") {
        for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
          const n = Number(v);
          if (k.trim() && Number.isFinite(n) && n > 0) map[k.trim().toLowerCase()] = Math.floor(n);
        }
      }
      out.push({ match, type: "map", map });
    } else {
      out.push({ match, type: "integer" });
    }
  }
  return out;
}

function sanitizeStyleRules(rules: unknown): StyleRule[] {
  if (!Array.isArray(rules)) return [];
  const out: StyleRule[] = [];
  for (const r of rules) {
    const match = String((r as { match?: unknown })?.match ?? "").trim();
    if (!match) continue;
    const rule: StyleRule = { match };
    const raw = (r as { map?: unknown })?.map;
    if (raw && typeof raw === "object") {
      const map: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        const value = String(v ?? "").trim();
        if (k.trim() && value) map[k.trim().toLowerCase()] = value;
      }
      if (Object.keys(map).length) rule.map = map;
    }
    out.push(rule);
  }
  return out;
}

function sanitizeStringList(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of list) {
    const s = String(v ?? "").trim();
    if (s && !seen.has(s.toLowerCase())) {
      seen.add(s.toLowerCase());
      out.push(s);
    }
  }
  return out;
}

/** Save a shop's figure/style rules + non-portrait classification config. */
export async function saveShopResolutionRules(input: {
  shopId: string;
  figureRules: FigureRule[];
  styleRules: StyleRule[];
  nonPortraitSkus: string[];
  nonPortraitTitles: string[];
  photoRequestEnabled: boolean;
}): Promise<void> {
  const user = await requireAdmin();
  const figureRules = sanitizeFigureRules(input.figureRules);
  const styleRules = sanitizeStyleRules(input.styleRules);
  const nonPortraitSkus = sanitizeStringList(input.nonPortraitSkus);
  const nonPortraitTitles = sanitizeStringList(input.nonPortraitTitles);
  await withUserContext(user, async (tx) => {
    const [s] = await tx
      .select({ cfg: shops.integrationConfig })
      .from(shops)
      .where(eq(shops.id, input.shopId));
    const cfg = (s?.cfg ?? {}) as Record<string, unknown>;
    await tx
      .update(shops)
      .set({
        integrationConfig: {
          ...cfg,
          figureRules,
          styleRules,
          nonPortraitSkus,
          nonPortraitTitles,
          photoRequestEnabled: !!input.photoRequestEnabled,
        },
      })
      .where(eq(shops.id, input.shopId));
  });
  revalidatePath("/settings");
}

/** Re-run figure + style resolution against a shop's already-imported orders. */
export async function reresolveShopOrders(shopId: string): Promise<ReresolveSummary> {
  const user = await requireAdmin();
  const summary = await reresolveShop(user, shopId);
  revalidatePath("/settings");
  revalidatePath("/orders");
  revalidatePath("/board");
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
