/**
 * Arm the STAGING database with mock integration credentials (docs/STAGING.md),
 * so the whole order journey (QC pass + proof email, print, tracking, platform
 * writeback) runs on a preview deployed with MOCK_INTEGRATIONS=1, where
 * lib/mock/transport.ts answers every call that presents a mock credential.
 * Nothing leaves the process: the proof email goes to the mock Gmail, print
 * lookups to the Gelato/Luma fixtures, fulfilment writebacks to the mock
 * Shopify/Etsy.
 *
 *   TARGET_URL=<staging owner url> ENCRYPTION_KEY=<the PREVIEW environment's key> \
 *     npx tsx scripts/staging/arm-mocks.ts
 *
 * ENCRYPTION_KEY must be the key the staging preview decrypts with (the
 * preview environment's ENCRYPTION_KEY, `vercel env pull --environment
 * preview`), or the deployment cannot read what is written here.
 *
 * Sets, for the PixArt business:
 *   gmail_credentials      mock Gmail OAuth (refresh token mock_rt_<b64 address>)
 *   email_sending_enabled  true   (the send gate; the mock catches the send)
 *   stage_email_auto_send  false  (stage emails stay drafts in the VA outbox)
 *   print_credentials      mock Gelato key + mock Luma basic auth
 * and for each of its shops a mock credential of its platform (Shopify legacy
 * shpat_mock token, Etsy mock_ keystring/secret/tokens). integration_config is
 * left alone (sync cursors, rules, the Shopify syncRoad).
 *
 * Disarm with scripts/staging/prepare.ts (nulls every credential again).
 * Refuses to touch the production endpoint.
 */
import { randomBytes } from "node:crypto";

import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { eq } from "drizzle-orm";
import ws from "ws";

import * as schema from "../../lib/db/schema";
import {
  encryptCredentials,
  getBusinessGmailCredentials,
  getBusinessPrintCredentials,
  getShopCredentials,
  type ShopCredentials,
} from "../../lib/db/credentials";
import type { Tx } from "../../lib/db";
import { isProdHost } from "./prod-endpoints";

neonConfig.webSocketConstructor = ws;

const BUSINESS_NAME = process.env.ARM_BUSINESS ?? "PixArt";
const HOUR = 3600_000;

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

const rand = (n: number) => randomBytes(n).toString("hex").slice(0, n);
const b64url = (s: string) => Buffer.from(s).toString("base64url");

function mockGmail(address: string): ShopCredentials {
  return {
    clientId: `mock_${rand(8)}.apps.googleusercontent.com`,
    clientSecret: `GOCSPX-mock_${rand(12)}`,
    refreshToken: `mock_rt_${b64url(address)}`,
    accessToken: `mock_gat_${b64url(address)}`,
    // Expired on purpose: the first send exercises the (mock) token refresh.
    accessTokenExpiresAt: new Date(Date.now() - 60_000).toISOString(),
    address,
    status: "connected",
    connectedAt: new Date().toISOString(),
  };
}

function mockPrint(): ShopCredentials {
  return {
    gelato: { apiKey: `mock_${rand(32)}-gelato`, webhookSecret: `mock_whsec_${rand(8)}` },
    lumaprints: { username: `mock_luma_${rand(6)}`, password: `mock_${rand(10)}`, storeId: "818", sandbox: true },
  };
}

function mockShop(platform: string, externalShopId: string | null): ShopCredentials | null {
  if (platform === "shopify") {
    if (!externalShopId?.endsWith(".myshopify.com")) return null;
    return {
      authType: "legacy",
      shopDomain: externalShopId,
      accessToken: `shpat_mock_${rand(26)}`,
      webhookSecret: `mock_shpss_${rand(20)}`,
      status: "connected",
    };
  }
  if (platform === "etsy") {
    if (!externalShopId) return null;
    return {
      keystring: `mock_${rand(24)}`,
      sharedSecret: `mock_${rand(12)}`,
      etsyShopId: externalShopId,
      etsyUserId: externalShopId,
      accessToken: `${externalShopId}.mock_at_${rand(8)}`,
      accessTokenExpiresAt: new Date(Date.now() - 60_000).toISOString(),
      refreshToken: `mock_rt_${rand(32)}`,
      refreshTokenExpiresAt: new Date(Date.now() + 90 * 24 * HOUR).toISOString(),
      status: "connected",
    };
  }
  return null;
}

/** "none" | "mock" | "REAL" | "unreadable": never prints a secret. */
async function kind(read: () => Promise<ShopCredentials | null>): Promise<string> {
  let c: ShopCredentials | null;
  try {
    c = await read();
  } catch {
    return "unreadable (other ENCRYPTION_KEY)";
  }
  if (!c || Object.keys(c).length === 0) return "none";
  const secrets = JSON.stringify(c).match(/"(apiKey|username|refreshToken|accessToken|keystring)":"([^"]*)"/g) ?? [];
  const values = secrets.map((s) => s.split(":").slice(1).join(":").replace(/"/g, ""));
  if (values.length && values.every((v) => /(^|\.)mock_|^shpat_mock/.test(v))) return "mock";
  return "REAL";
}

async function snapshot(tx: Tx, businessId: string) {
  const [b] = await tx
    .select({
      emailSendingEnabled: schema.businesses.emailSendingEnabled,
      stageEmailAutoSend: schema.businesses.stageEmailAutoSend,
      dailyHealthEmailEnabled: schema.businesses.dailyHealthEmailEnabled,
      gmailAddress: schema.businesses.gmailAddress,
    })
    .from(schema.businesses)
    .where(eq(schema.businesses.id, businessId));
  const shops = await tx
    .select({ id: schema.shops.id, name: schema.shops.name, platform: schema.shops.platform })
    .from(schema.shops)
    .where(eq(schema.shops.businessId, businessId));
  const shopKinds: Record<string, string> = {};
  for (const s of shops) shopKinds[`${s.name} (${s.platform})`] = await kind(() => getShopCredentials(tx, s.id));
  return {
    email_sending_enabled: b.emailSendingEnabled,
    stage_email_auto_send: b.stageEmailAutoSend,
    daily_health_email_enabled: b.dailyHealthEmailEnabled,
    gmail_address: b.gmailAddress,
    gmail_credentials: await kind(() => getBusinessGmailCredentials(tx, businessId)),
    print_credentials: await kind(() => getBusinessPrintCredentials(tx, businessId)),
    shops: shopKinds,
  };
}

async function main() {
  const url = need("TARGET_URL");
  need("ENCRYPTION_KEY");
  const parsed = new URL(url);
  if (isProdHost(parsed.hostname)) throw new Error("TARGET_URL is the production database; refusing.");
  if (parsed.username !== "neondb_owner") throw new Error("TARGET_URL must be the staging owner connection");

  const pool = new Pool({ connectionString: url, max: 1 });
  const db = drizzle(pool, { schema });

  const result = await db.transaction(async (raw) => {
    const tx = raw as unknown as Tx;
    const [biz] = await tx
      .select({ id: schema.businesses.id, gmailAddress: schema.businesses.gmailAddress })
      .from(schema.businesses)
      .where(eq(schema.businesses.name, BUSINESS_NAME));
    if (!biz) throw new Error(`${BUSINESS_NAME} business not found`);

    const before = await snapshot(tx, biz.id);
    const address = biz.gmailAddress ?? "orders@pixartcreatives.co";

    await tx
      .update(schema.businesses)
      .set({
        gmailCredentials: encryptCredentials(mockGmail(address)),
        gmailAddress: address,
        emailSendingEnabled: true,
        stageEmailAutoSend: false,
        dailyHealthEmailEnabled: false,
        printCredentials: encryptCredentials(mockPrint()),
      })
      .where(eq(schema.businesses.id, biz.id));

    const shops = await tx
      .select({ id: schema.shops.id, name: schema.shops.name, platform: schema.shops.platform, externalShopId: schema.shops.externalShopId })
      .from(schema.shops)
      .where(eq(schema.shops.businessId, biz.id));
    const skipped: string[] = [];
    for (const s of shops) {
      const creds = mockShop(s.platform, s.externalShopId);
      if (!creds) {
        skipped.push(`${s.name} (${s.platform}): no mock shape for this shop, left as is`);
        continue;
      }
      await tx.update(schema.shops).set({ credentials: encryptCredentials(creds) }).where(eq(schema.shops.id, s.id));
    }

    const after = await snapshot(tx, biz.id);
    const ok =
      after.email_sending_enabled &&
      !after.stage_email_auto_send &&
      after.gmail_credentials === "mock" &&
      after.print_credentials === "mock" &&
      Object.values(after.shops).every((k) => k === "mock" || k === "none");
    if (!ok) throw new Error("arm verification failed; rolled back: " + JSON.stringify(after));
    return { business: BUSINESS_NAME, before, after, skipped };
  });

  console.log("BEFORE " + JSON.stringify(result.before, null, 2));
  console.log("AFTER  " + JSON.stringify(result.after, null, 2));
  for (const s of result.skipped) console.log("skipped: " + s);
  await pool.end();
  console.log(`staging armed with mock integrations for ${result.business} (disarm: scripts/staging/prepare.ts)`);
}

main().catch((err) => {
  console.error("arm-mocks failed:", err.cause?.message ?? err.message);
  process.exit(1);
});
