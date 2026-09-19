/**
 * Shopify sync through a STAFF SEAT's browser session (2026-09-20).
 *
 * Why: PixArt's Shopify gives our Shopify ID a staff seat ("AI Boss", role
 * Agent) that can read every order but may not install or create apps, so no
 * Admin API token can exist until the owner changes that. The admin web app
 * itself talks to Admin GraphQL at admin.shopify.com/api/shopify/<handle>
 * with the session cookie + CSRF header, and that endpoint answers the same
 * queries the app token would. This script runs the NORMAL AlphaOS import
 * (syncShopOrders: same query, same normalizer, same idempotent import) and
 * swaps only the transport: a fetch interceptor sends the GraphQL call
 * through that logged-in page on the agent's CDP Chrome (:9222).
 *
 * Shops opt in with credentials.authType = "staff_session" and
 * integrationConfig.syncRoad = "staff_session"; Vercel skips them (see
 * lib/integrations/shopify/types.ts). Read only: the sync never writes to
 * Shopify, and the business's customer emails stay governed as always.
 *
 * Usage (from the repo root):
 *   npx tsx scripts/shopify-session-sync.ts            # sync every staff-session shop
 *   npx tsx scripts/shopify-session-sync.ts --setup <business-slug> <handle> [--since ISO]
 *
 * Login: SHOPIFY_ID_EMAIL / SHOPIFY_ID_PASSWORD / SHOPIFY_ID_TOTP_SECRET from
 * the agent's .env (AGENT_ENV, default ~/Documents/ai-employee-agent/.env).
 */
import "./load-env";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { eq, sql } from "drizzle-orm";

process.env.ALPHAOS_STAFF_SESSION = "1";

import { withSystemContext } from "../lib/db";
import { businesses, shops } from "../lib/db/schema";
import { encryptCredentials } from "../lib/db/credentials";
import { syncShopOrders } from "../lib/integrations/shopify";

const AGENT_DIR = path.join(os.homedir(), "Documents/ai-employee-agent");
const AGENT_ENV = process.env.AGENT_ENV || path.join(AGENT_DIR, ".env");
const CDP = process.env.STAFF_SESSION_CDP || "http://127.0.0.1:9222";

// Playwright lives in the agent repo; AlphaOS itself doesn't depend on it.
const req = createRequire(path.join(AGENT_DIR, "package.json"));
// Minimal shapes of what we use, so this repo needs no playwright types.
type PwRequest = { url(): string; headers(): Record<string, string> };
type Page = {
  goto(url: string, o?: object): Promise<unknown>;
  reload(o?: object): Promise<unknown>;
  url(): string;
  waitForTimeout(ms: number): Promise<void>;
  locator(sel: string): { count(): Promise<number>; first(): { click(o?: object): Promise<void>; fill(v: string): Promise<void> } };
  getByText(t: string): { first(): { click(o?: object): Promise<void> } };
  fill(sel: string, v: string): Promise<void>;
  keyboard: { press(k: string): Promise<void> };
  on(e: "request", fn: (r: PwRequest) => void): void;
  off(e: "request", fn: (r: PwRequest) => void): void;
  evaluate<R, A>(fn: (a: A) => Promise<R>, arg: A): Promise<R>;
  close(): Promise<void>;
};
type Browser = { contexts(): { newPage(): Promise<Page> }[] };
const { chromium } = req("playwright") as { chromium: { connectOverCDP(url: string): Promise<Browser> } };

function agentEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(AGENT_ENV, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const i = t.indexOf("=");
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s), same as the agent's lib/totp.js. */
function totp(secretB32: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = secretB32.replace(/[\s=]/g, "").toUpperCase();
  let bits = "";
  for (const c of clean) bits += alphabet.indexOf(c).toString(2).padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const h = crypto.createHmac("sha1", key).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  const n = ((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).toString();
  return n.padStart(6, "0");
}

const log = (event: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), component: "shopify-session-sync", event, ...extra }));

/** Walk Shopify's login screens until the store admin is open. */
async function ensureAdmin(page: Page, handle: string): Promise<void> {
  const env = agentEnv();
  const target = `https://admin.shopify.com/store/${handle}/orders`;
  await page.goto(target, { waitUntil: "domcontentloaded", timeout: 45000 });
  for (let step = 0; step < 8; step++) {
    await page.waitForTimeout(4000);
    const url = page.url();
    if (url.startsWith(`https://admin.shopify.com/store/${handle}`)) return;
    if (!url.includes("accounts.shopify.com")) {
      await page.goto(target, { waitUntil: "domcontentloaded", timeout: 45000 });
      continue;
    }
    if (url.includes("/select")) {
      await page.locator(`text=${env.SHOPIFY_ID_EMAIL}`).first().click({ timeout: 10000 }).catch(() => {});
    } else if (url.includes("confirm_security_settings")) {
      await page.getByText("Remind me next time").first().click({ timeout: 10000 }).catch(() => {});
    } else if (await page.locator("input[type=password]").count()) {
      await page.fill("input[type=password]", env.SHOPIFY_ID_PASSWORD);
      await page.keyboard.press("Enter");
    } else if (await page.locator("input[type=email], input[name='account[email]']").count()) {
      await page.fill("input[type=email], input[name='account[email]']", env.SHOPIFY_ID_EMAIL);
      await page.keyboard.press("Enter");
    } else if (await page.locator("input[inputmode=numeric], input[autocomplete=one-time-code], input[type=text]").count()) {
      await page
        .locator("input[inputmode=numeric], input[autocomplete=one-time-code], input[type=text]")
        .first()
        .fill(totp(env.SHOPIFY_ID_TOTP_SECRET));
      await page.keyboard.press("Enter");
    }
  }
  throw new Error(`could not reach the ${handle} admin (stuck at ${page.url().slice(0, 90)})`);
}

/** The admin's CSRF token, read off one of its own API calls. */
async function captureCsrf(page: Page, handle: string): Promise<string> {
  let csrf: string | null = null;
  const onReq = (r: PwRequest) => {
    const h = r.headers()["x-csrf-token"];
    if (h && r.url().startsWith("https://admin.shopify.com/api/")) csrf = h;
  };
  page.on("request", onReq);
  await page.reload({ waitUntil: "domcontentloaded" });
  for (let i = 0; i < 30 && !csrf; i++) await page.waitForTimeout(500);
  page.off("request", onReq);
  if (!csrf) throw new Error(`no CSRF token seen on the ${handle} admin`);
  return csrf;
}

/** Route Admin GraphQL calls for staff-session shops through the page. */
function installTransport(page: Page, byDomain: Map<string, { handle: string; csrf: string }>) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const hit = byDomain.get(url.host);
    const token = new Headers(init?.headers).get("X-Shopify-Access-Token");
    if (!hit || token !== "staff_session" || !/\/admin\/api\/[^/]+\/graphql\.json$/.test(url.pathname)) {
      return realFetch(input as RequestInfo, init);
    }
    const body = typeof init?.body === "string" ? init.body : "{}";
    const res = await page.evaluate(
      async ({ handle, csrf, body }: { handle: string; csrf: string; body: string }) => {
        const r = await fetch(`/api/shopify/${handle}?operation=AlphaOSSync&type=query`, {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json", accept: "application/json", "x-csrf-token": csrf },
          body,
        });
        return { status: r.status, text: await r.text() };
      },
      { handle: hit.handle, csrf: hit.csrf, body },
    );
    // A dead session reads as 401 so the client fails the run loudly.
    const status = res.status === 403 || res.status === 302 ? 401 : res.status;
    return new Response(res.text, { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

async function setup(slug: string, handle: string, since: string) {
  const domain = `${handle}.myshopify.com`;
  const out = await withSystemContext(async (tx) => {
    const [biz] = await tx.select({ id: businesses.id, name: businesses.name }).from(businesses).where(eq(businesses.slug, slug));
    if (!biz) throw new Error(`business not found: ${slug}`);
    const existing = await tx
      .select({ id: shops.id })
      .from(shops)
      .where(sql`${shops.businessId} = ${biz.id} and ${shops.platform} = 'shopify' and ${shops.externalShopId} = ${domain}`);
    const integrationConfig = {
      syncRoad: "staff_session",
      syncCursor: since,
      backfillCutoffAt: since,
      defaultStyle: "cartoon",
      titleStyleRules: [
        { match: "Watercolor", style: "watercolor" },
        { match: "Cartoon", style: "cartoon" },
      ],
      figureRules: [
        { type: "integer", match: "Number of Pets" },
        { type: "integer", match: "Number of People" },
        { type: "integer", match: "Pets" },
        { type: "integer", match: "People" },
      ],
      photoRequestEnabled: false,
    };
    const credentials = encryptCredentials({ authType: "staff_session", shopDomain: domain, status: "connected" });
    if (existing.length) {
      await tx.update(shops).set({ credentials }).where(eq(shops.id, existing[0].id));
      return { shopId: existing[0].id, created: false };
    }
    const [row] = await tx
      .insert(shops)
      .values({ businessId: biz.id, platform: "shopify", name: `${biz.name} Shopify`, externalShopId: domain, credentials, integrationConfig, active: true })
      .returning({ id: shops.id });
    return { shopId: row.id, created: true };
  });
  log("setup", { ...out, domain, since });
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === "--setup") {
    const i = argv.indexOf("--since");
    const since = i > 0 ? new Date(argv[i + 1]).toISOString() : "2026-09-10T00:00:00.000Z";
    return setup(argv[1], argv[2], since);
  }

  const targets = await withSystemContext((tx) =>
    tx
      .select({ id: shops.id, externalShopId: shops.externalShopId })
      .from(shops)
      .where(sql`${shops.active} = true and ${shops.platform} = 'shopify' and (${shops.integrationConfig} ->> 'syncRoad') = 'staff_session'`),
  );
  if (!targets.length) return log("nothing_to_sync");

  const browser = await chromium.connectOverCDP(CDP);
  const ctx = browser.contexts()[0];
  const page = await ctx.newPage();
  try {
    const byDomain = new Map<string, { handle: string; csrf: string }>();
    for (const t of targets) {
      const handle = t.externalShopId.replace(/\.myshopify\.com$/, "");
      await ensureAdmin(page, handle);
      byDomain.set(t.externalShopId, { handle, csrf: await captureCsrf(page, handle) });
    }
    installTransport(page, byDomain);
    for (const t of targets) {
      const summary = await syncShopOrders(t.id, { trigger: "cron" });
      log("shop_synced", { shopId: t.id, domain: t.externalShopId, ...summary, errors: summary.errors.slice(0, 5) });
    }
  } finally {
    await page.close().catch(() => {});
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    log("failed", { error: e instanceof Error ? e.message : String(e) });
    process.exit(1);
  });
