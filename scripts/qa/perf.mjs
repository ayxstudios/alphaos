#!/usr/bin/env node
// Page speed walk (docs/PERF.md). Headless only, never a visible window.
//
//   node scripts/qa/perf.mjs --base https://alphaos-staging.vercel.app --role admin \
//     --order <orderId> --out var/perf/admin.json [--viewports laptop,phone] [--shots var/e2e-shots/perf/before]
//
// Logins come from STAGING_<ROLE>_EMAIL / STAGING_<ROLE>_PASSWORD in the env
// (load ~/Documents/ai-employee-agent/.local/alphaos-staging.env first); they
// are never printed.
//
// Per page it records, for a COLD load (fresh browser context: no HTTP cache,
// new TLS connection) and a WARM reload (same context, right after):
//   ttfb = finalResponseHeadersStart (not a 103 Early Hint), html = responseEnd, dcl = domContentLoadedEventEnd, lcp = last LCP entry
// Then it walks the app like a person, clicking the sidebar (laptop) or the
// bottom tabs / More drawer (phone), twice: the first pass is a cold client
// navigation, the second a warm one. nav = click -> URL changed and no
// skeleton left in <main> (the page's real content rendered and hydrated).
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const require = createRequire("/Users/almacorp2/Documents/ai-employee-agent/package.json");
const { chromium } = require("playwright");

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const base = (args.base || "https://alphaos-staging.vercel.app").replace(/\/$/, "");
const role = args.role || "admin";
const orderId = args.order;
const out = args.out || `var/perf/${role}.json`;
const shots = args.shots || null;
const viewports = (args.viewports || "laptop,phone").split(",");
// Network profiles (CDP), per the owner's "fast on any connection" bar.
const THROTTLE = {
  none: null,
  fast3g: { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 },
  slow3g: { offline: false, latency: 400, downloadThroughput: (400 * 1024) / 8, uploadThroughput: (400 * 1024) / 8 },
};
const throttle = THROTTLE[args.throttle || "none"];
const T = throttle ? 120000 : 30000; // timeouts
const passes = (args.passes || "navCold,navWarm").split(",");
const email = process.env[`STAGING_${role.toUpperCase()}_EMAIL`];
const password = process.env[`STAGING_${role.toUpperCase()}_PASSWORD`];
if (!email || !password) throw new Error(`no login for ${role} in env`);

const ALL = [
  "/dashboard", "/today", "/orders", "ORDER", "/qc", "/emails", "/board", "/queue/print",
  "/payouts", "/settings", "/designers", "/styles", "/health", "/customers", "/me", "/help",
];
const ROLE_PAGES = {
  admin: ALL,
  va: ALL.filter((p) => !["/payouts", "/health"].includes(p)),
  designer: ["/dashboard", "/board", "ORDER", "/me", "/help"],
};
const pages = ROLE_PAGES[role].map((p) => (p === "ORDER" ? `/orders/${orderId}` : p)).filter((p) => !p.endsWith("/undefined"));

const VIEWPORTS = {
  laptop: { viewport: { width: 1280, height: 800 } },
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
};

// LCP observer installed before any page script runs.
const LCP_INIT = `(() => {
  window.__lcp = 0;
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lcp = e.startTime; })
      .observe({ type: "largest-contentful-paint", buffered: true });
  } catch {}
})();`;

const browser = await chromium.launch({ headless: true, channel: "chrome" });

async function newPage(ctx) {
  const page = await ctx.newPage();
  if (throttle) {
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", throttle);
  }
  return page;
}

async function login() {
  const ctx = await browser.newContext(VIEWPORTS.laptop);
  const page = await ctx.newPage();
  await page.goto(`${base}/login`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"], input[name="password"]', password);
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60000 }), page.click('button[type="submit"]')]);
  const state = await ctx.storageState();
  await ctx.close();
  return state;
}

async function dismissTour(page) {
  for (const name of ["Skip tour", "Later"]) {
    const b = page.getByRole("button", { name, exact: true });
    if (await b.isVisible().catch(() => false)) await b.click().catch(() => {});
  }
}

const settled = (target) => `(() => {
  if (location.pathname !== ${JSON.stringify(target)}) return false;
  const main = document.querySelector("main");
  if (!main) return false;
  return !main.querySelector(".animate-pulse");
})()`;

async function loadMetrics(page, url) {
  const resp = await page.goto(url, { waitUntil: "commit", timeout: T });
  // ready = the page's real content is in <main> (no skeleton left), from navigation start.
  const ready = await page
    .waitForFunction(settled(new URL(page.url()).pathname), null, { timeout: T, polling: 16 })
    .then(() => page.evaluate(() => Math.round(performance.now())))
    .catch(() => null);
  await page.waitForLoadState("load", { timeout: T }).catch(() => {});
  await page.waitForTimeout(300);
  // A page can redirect itself after load (e.g. /orders restores a saved view): read the final document.
  const read = () => page.evaluate(() => {
    const n = performance.getEntriesByType("navigation")[0];
    const fcp = performance.getEntriesByName("first-contentful-paint")[0];
    return { ttfb: Math.round(n.finalResponseHeadersStart || n.responseStart), html: Math.round(n.responseEnd), fcp: Math.round(fcp?.startTime || 0), dcl: Math.round(n.domContentLoadedEventEnd), lcp: Math.round(window.__lcp || 0), load: Math.round(n.loadEventEnd), bytes: Math.round(performance.getEntriesByType("resource").reduce((a, r) => a + (r.transferSize || 0), n.transferSize || 0) / 1024) };
  });
  let m = null;
  for (let i = 0; i < 4 && !m; i++) {
    m = await read().catch(async () => {
      await page.waitForLoadState("load", { timeout: T }).catch(() => {});
      await page.waitForTimeout(500);
      return null;
    });
  }
  return { status: resp?.status() ?? null, finalPath: new URL(page.url()).pathname, ready, ...m };
}

async function clickTo(page, target, vp, finalPath = target) {
  // Laptop: the sidebar link. Phone: a bottom tab, else the More drawer's link.
  // A page with no link in the nav (the order page) opens the first link to it
  // on the current page, else the app router (same fetch as a Link, no prefetch).
  const visible = (sel) => page.locator(sel).filter({ visible: true }).first();
  const has = (l) => l.count().then((n) => n > 0).catch(() => false);
  let link = visible(`aside a[href="${target}"], nav a[href="${target}"]`);
  if (vp === "phone" && !(await has(link)) && !target.startsWith("/orders/")) {
    const more = visible('[data-tour="tab:more"]');
    if (await has(more)) {
      await more.click();
      await page.waitForTimeout(250);
      link = visible(`aside a[href="${target}"]`);
      if (!(await has(link))) {
        const close = visible('button[aria-label="Close navigation"]');
        if (await has(close)) await close.click().catch(() => {});
      }
    }
  }
  if (!(await has(link))) link = visible(`main a[href="${target}"]`);
  const via = (await has(link)) ? "link" : "router";
  const t0 = Date.now();
  if (via === "link") await link.click({ noWaitAfter: true });
  else await page.evaluate((t) => window.next.router.push(t), target);
  const ok = await page.waitForFunction(settled(finalPath), null, { timeout: T, polling: 16 }).then(() => true).catch(() => false);
  const ms = Date.now() - t0;
  return { ms: ok ? ms : null, via, finalPath: new URL(page.url()).pathname };
}

const state = await login();
const result = { base, role, throttle: args.throttle || "none", at: new Date().toISOString(), pages: {}, floor: {} };
const save = () => {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(result, null, 1));
};

for (const vp of viewports) {
  // Network floor: a no-database function in the same region (iad1).
  {
    const ctx = await browser.newContext({ ...VIEWPORTS[vp] });
    const page = await newPage(ctx);
    const samples = [];
    for (let i = 0; i < 4; i++) {
      await page.goto(`${base}/api/health`, { waitUntil: "load" });
      samples.push(Math.round(await page.evaluate(() => { const n = performance.getEntriesByType("navigation")[0]; return n.finalResponseHeadersStart || n.responseStart; })));
    }
    result.floor[vp] = { coldTtfb: samples[0], warmTtfb: Math.min(...samples.slice(1)) };
    await ctx.close();
  }

  // Cold + warm full loads.
  for (const path of pages) {
    const ctx = await browser.newContext({ ...VIEWPORTS[vp], storageState: state });
    await ctx.addInitScript(LCP_INIT);
    const page = await newPage(ctx);
    const cold = await loadMetrics(page, base + path);
    await dismissTour(page);
    const warm = await loadMetrics(page, base + path);
    if (shots) {
      mkdirSync(shots, { recursive: true });
      await page.screenshot({ path: `${shots}/${role}-${vp}-${path.replace(/^\//, "").replace(/\//g, "_") || "root"}.png`, fullPage: false });
    }
    (result.pages[path] ??= {})[vp] = { cold, warm };
    console.error(`${role} ${vp} ${path} cold ttfb=${cold.ttfb} fcp=${cold.fcp} ready=${cold.ready} lcp=${cold.lcp} | warm ttfb=${warm.ttfb} fcp=${warm.fcp} ready=${warm.ready} lcp=${warm.lcp}`);
    await ctx.close();
    save();
  }

  // Click-through walk, twice (cold then warm client navigation).
  const ctx = await browser.newContext({ ...VIEWPORTS[vp], storageState: state });
  const page = await newPage(ctx);
  await page.goto(base + pages[0], { waitUntil: "load", timeout: T });
  await dismissTour(page);
  for (const pass of passes) {
    for (const [i, path] of pages.entries()) {
      const from = i === 0 ? pages[pages.length - 1] : pages[i - 1];
      // A page that redirects this role (e.g. /me for staff) settles on its final path.
      const expect = (p) => result.pages[p]?.[vp]?.cold?.finalPath ?? p;
      try {
        if (new URL(page.url()).pathname !== expect(from)) await clickTo(page, from, vp, expect(from));
        await page.waitForTimeout(1200); // a person reads before the next click; viewport prefetch runs meanwhile
        const r = await clickTo(page, path, vp, expect(path));
        ((result.pages[path] ??= {})[vp] ??= {})[pass] = r;
        console.error(`${role} ${vp} ${pass} -> ${path}: ${r.ms}ms via ${r.via}`);
      } catch (e) {
        console.error(`${role} ${vp} ${pass} -> ${path}: FAILED ${String(e).split("\n")[0]}`);
        await page.goto(base + expect(path), { waitUntil: "load" }).catch(() => {});
      }
    }
    save();
  }
  await ctx.close();
}

await browser.close();
save();
console.error(`wrote ${out}`);
