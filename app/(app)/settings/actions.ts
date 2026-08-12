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
import { shops, businesses, emailTemplates, printProductMappings } from "@/lib/db/schema";
import { reresolveShop, type ReresolveSummary } from "@/lib/orders/resolution";
import type { FigureRule } from "@/lib/integrations/figures";
import type { GmailCredentials } from "@/lib/integrations/gmail";
import { pollMailbox, GmailClient, GmailNotConnectedError, type InboundSummary } from "@/lib/integrations/gmail";
import {
  DEFAULT_TEMPLATES,
  TEMPLATE_META,
  renderTemplate,
  resolveTemplate,
  type TemplateKey,
} from "@/lib/email/templates";
import { appUrl } from "@/lib/urls";
import { previewNotificationSweep, type NotificationSweepResult } from "@/lib/notifications/sla-sweep";
import { ensureBackfillCutoff } from "@/lib/orders/archive";
import {
  syncShopReceipts,
  type SyncSummary,
  type EtsyCredentials,
  type EtsyIntegrationConfig,
} from "@/lib/integrations/etsy";
import {
  syncShopOrders,
  verifyShopifyToken,
  verifyShopifyClientCredentials,
  ensureShopifyOrdersCreateWebhook,
  freshShopifyCredentials,
  type SyncSummary as ShopifySyncSummary,
  type ShopifyCredentials,
  type ShopifyAuthType,
  type ShopifyIntegrationConfig,
  type ShopifyWebhookRegistrationResult,
} from "@/lib/integrations/shopify";

function normalizeDomain(input: string): string {
  return input.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "").toLowerCase();
}

function cutoffFromDateInput(value: string): string {
  const raw = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new Error("Cutoff date must be YYYY-MM-DD");
  return new Date(`${raw}T00:00:00.000Z`).toISOString();
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
    const [s] = await tx.select({ cfg: shops.integrationConfig }).from(shops).where(eq(shops.id, shopId));
    await tx
      .update(shops)
      .set({ integrationConfig: ensureBackfillCutoff((s?.cfg ?? {}) as EtsyIntegrationConfig) })
      .where(eq(shops.id, shopId));
  });
  revalidatePath("/settings");
}

export async function saveShopBackfillCutoff(formData: FormData): Promise<void> {
  const user = await requireAdmin();
  const shopId = String(formData.get("shopId") ?? "");
  const cutoff = cutoffFromDateInput(String(formData.get("backfillCutoffDate") ?? ""));
  if (!shopId) throw new Error("Missing shop");

  await withUserContext(user, async (tx) => {
    const [s] = await tx.select({ cfg: shops.integrationConfig }).from(shops).where(eq(shops.id, shopId));
    const cfg = (s?.cfg ?? {}) as Record<string, unknown>;
    await tx
      .update(shops)
      .set({ integrationConfig: { ...cfg, backfillCutoffAt: cutoff } })
      .where(eq(shops.id, shopId));
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
  const summary = await syncShopReceipts(shopId, { mode: "backfill" });
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
  let savedCreds: ShopifyCredentials | null = null;

  await withUserContext(user, async (tx) => {
    const creds = (await getShopCredentials(tx, shopId)) as ShopifyCredentials;

    if (authType === "client_credentials") {
      const clientId = String(formData.get("clientId") ?? "").trim() || creds.clientId;
      const clientSecret = String(formData.get("clientSecret") ?? "").trim() || creds.clientSecret;
      if (!clientId || !clientSecret) throw new Error("Client ID and secret are required");
      savedCreds = {
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
      };
      await setShopCredentials(tx, shopId, savedCreds);
    } else {
      const accessToken = String(formData.get("accessToken") ?? "").trim() || creds.accessToken;
      const webhookSecret = String(formData.get("webhookSecret") ?? "").trim() || creds.webhookSecret;
      if (!accessToken || !webhookSecret) throw new Error("Access token and webhook secret are required");
      savedCreds = {
        ...creds,
        authType: "legacy",
        shopDomain,
        accessToken,
        webhookSecret,
        clientId: undefined,
        clientSecret: undefined,
        accessTokenExpiresAt: undefined,
        status: "connected",
      };
      await setShopCredentials(tx, shopId, savedCreds);
    }

    // Keep external_shop_id aligned with the domain so the webhook can find it,
    // and initialize the historical-import cutoff the first time the shop connects.
    const [s] = await tx.select({ cfg: shops.integrationConfig }).from(shops).where(eq(shops.id, shopId));
    await tx
      .update(shops)
      .set({
        externalShopId: shopDomain,
        integrationConfig: ensureBackfillCutoff((s?.cfg ?? {}) as ShopifyIntegrationConfig),
      })
      .where(eq(shops.id, shopId));
  });

  if (savedCreds) {
    await freshShopifyCredentials(savedCreds)
      .then((liveCreds) => ensureShopifyOrdersCreateWebhook(shopId, liveCreds))
      .catch((e) => {
        console.log(
          JSON.stringify({
            ts: new Date().toISOString(),
            level: "error",
            component: "settings",
            integration: "shopify",
            shopId,
            event: "webhook_auto_register_failed",
            error: e instanceof Error ? e.message : String(e),
          }),
        );
      });
  }
  revalidatePath("/settings");
}

export async function triggerShopifySync(shopId: string): Promise<ShopifySyncSummary> {
  await requireAdmin();
  const summary = await syncShopOrders(shopId);
  revalidatePath("/settings");
  return summary;
}

export async function registerShopifyWebhooks(shopId: string): Promise<ShopifyWebhookRegistrationResult> {
  const user = await requireAdmin();
  const creds = (await withUserContext(user, (tx) =>
    getShopCredentials(tx, shopId),
  )) as ShopifyCredentials;
  const result = await ensureShopifyOrdersCreateWebhook(shopId, await freshShopifyCredentials(creds));
  revalidatePath("/settings");
  return result;
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
  const summary = await syncShopOrders(shopId, { suppressCustomerEmail: true, mode: "backfill" });
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
  nonPortraitSkus: string[];
  nonPortraitTitles: string[];
  photoRequestEnabled: boolean;
}): Promise<void> {
  const user = await requireAdmin();
  const figureRules = sanitizeFigureRules(input.figureRules);
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

/** Safety rail: turn customer email sending on/off for a business (default OFF). */
export async function setEmailSendingEnabled(businessId: string, enabled: boolean): Promise<void> {
  const user = await requireAdmin();
  await withUserContext(user, (tx) =>
    tx.update(businesses).set({ emailSendingEnabled: enabled }).where(eq(businesses.id, businessId)),
  );
  revalidatePath("/settings");
}

export type GmailTestResult = {
  ok: boolean;
  message?: string;
  results: { key: string; label: string; ok: boolean; error?: string }[];
};

/**
 * Send a sample of every template to a staff-chosen address to verify the Gmail
 * connection. Deliberately bypasses the sending toggle (it only ever emails the
 * address a staff member typed) and never writes to the messages table.
 */
export async function sendGmailTest(businessId: string, toRaw: string): Promise<GmailTestResult> {
  const user = await requireAdmin();
  const to = toRaw.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    return { ok: false, message: "Enter a valid email address", results: [] };
  }

  const businessName = await withUserContext(user, async (tx) => {
    const [b] = await tx.select({ name: businesses.name }).from(businesses).where(eq(businesses.id, businessId));
    return b?.name ?? "your business";
  });

  let client: GmailClient;
  try {
    client = await GmailClient.forBusiness(businessId);
  } catch (e) {
    const msg =
      e instanceof GmailNotConnectedError
        ? "Gmail isn't connected for this business yet — connect it first."
        : e instanceof Error
          ? e.message
          : "Could not open Gmail";
    return { ok: false, message: msg, results: [] };
  }

  const vars = {
    first_name: "Sam (test)",
    order_number: "TEST-1001",
    business_name: businessName,
    proof_link: appUrl("/proof/sample-test"),
    upload_link: appUrl("/u/sample-test"),
  };

  const keys: TemplateKey[] = ["photo_request", "proof_ready", "revision_received"];
  const results: GmailTestResult["results"] = [];
  for (const key of keys) {
    try {
      const tpl = await withUserContext(user, (tx) => resolveTemplate(tx, businessId, key));
      const rendered = renderTemplate(tpl, vars);
      await client.send({ to, subject: `[TEST] ${rendered.subject}`, text: rendered.body });
      results.push({ key, label: TEMPLATE_META[key].label, ok: true });
    } catch (e) {
      results.push({ key, label: TEMPLATE_META[key].label, ok: false, error: e instanceof Error ? e.message : "Send failed" });
    }
  }
  const okAll = results.every((r) => r.ok);
  return {
    ok: okAll,
    message: okAll ? `Sent ${results.length} test emails to ${to}` : "Some test emails failed — see below",
    results,
  };
}

export async function runNotificationDryRun(): Promise<
  { ok: true; report: NotificationSweepResult } | { ok: false; message: string }
> {
  try {
    const user = await requireAdmin();
    const report = await previewNotificationSweep(user);
    return { ok: true, report };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Dry-run failed" };
  }
}

/* --- Print fulfilment ---------------------------------------------------- */

function assertPrintProvider(value: string): "gelato" | "lumaprints" {
  if (value === "gelato" || value === "lumaprints") return value;
  throw new Error("Unknown print provider");
}

function assertPrintMatchType(value: string): "sku_exact" | "title_variant_contains" {
  if (value === "sku_exact" || value === "title_variant_contains") return value;
  throw new Error("Unknown print mapping matcher");
}

export async function savePrintProductMapping(formData: FormData): Promise<void> {
  const user = await requireAdmin();
  const mappingId = String(formData.get("mappingId") ?? "").trim();
  const shopId = String(formData.get("shopId") ?? "").trim();
  const provider = assertPrintProvider(String(formData.get("provider") ?? ""));
  const matchType = assertPrintMatchType(String(formData.get("matchType") ?? "sku_exact"));
  const sourceSku = String(formData.get("sourceSku") ?? "").trim();
  const titleContains = String(formData.get("titleContains") ?? "").trim();
  const variantContains = String(formData.get("variantContains") ?? "").trim();
  const label = String(formData.get("label") ?? "").trim();
  const providerProductId = String(formData.get("providerProductId") ?? "").trim();
  const providerConfigRaw = String(formData.get("providerConfig") ?? "").trim();
  if (!shopId || !providerProductId) throw new Error("Shop and provider product id are required");
  if (matchType === "sku_exact" && !sourceSku) throw new Error("Exact SKU mappings require a source SKU");
  if (matchType === "title_variant_contains" && !titleContains && !variantContains) {
    throw new Error("Contains mappings require a title or variant fragment");
  }

  let providerConfig: unknown = null;
  if (providerConfigRaw) {
    try {
      providerConfig = JSON.parse(providerConfigRaw);
    } catch {
      throw new Error("Provider config must be valid JSON");
    }
  }

  await withUserContext(user, async (tx) => {
    const [shop] = await tx
      .select({ id: shops.id, businessId: shops.businessId })
      .from(shops)
      .where(eq(shops.id, shopId))
      .limit(1);
    if (!shop) throw new Error("Shop not found");

    const values = {
      businessId: shop.businessId,
      shopId,
      provider,
      matchType,
      sourceSku: sourceSku || null,
      titleContains: titleContains || null,
      variantContains: variantContains || null,
      label: label || null,
      providerProductId,
      providerConfig,
      active: true,
      updatedAt: new Date(),
    };
    if (mappingId) {
      await tx.update(printProductMappings).set(values).where(eq(printProductMappings.id, mappingId));
    } else {
      await tx.insert(printProductMappings).values(values);
    }
  });
  revalidatePath("/settings");
  revalidatePath("/queue/print");
}

export async function deactivatePrintProductMapping(formData: FormData): Promise<void> {
  const user = await requireAdmin();
  const mappingId = String(formData.get("mappingId") ?? "").trim();
  if (!mappingId) throw new Error("Missing mapping");
  await withUserContext(user, (tx) =>
    tx
      .update(printProductMappings)
      .set({ active: false, updatedAt: new Date() })
      .where(eq(printProductMappings.id, mappingId)),
  );
  revalidatePath("/settings");
  revalidatePath("/queue/print");
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
