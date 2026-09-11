#!/usr/bin/env node
// QA walk: log in as a role, visit every page, screenshot desktop + phone,
// record console errors, failed requests, horizontal overflow and tiny tap
// targets. One JSON line per page on stdout; PNGs in --out.
//
//   node scripts/qa/walk.mjs --base http://localhost:3111 --role va --out var/qa
//   node scripts/qa/walk.mjs --role designer --pages /board,/orders
//   node scripts/qa/walk.mjs --role admin --width 1024   # desktop viewport override
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire("/Users/almacorp2/Documents/ai-employee-agent/package.json");
const { chromium } = require("patchright");

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith("--") ? [a.slice(2), arr[i + 1] && !arr[i + 1].startsWith("--") ? arr[i + 1] : true] : []).filter(Boolean));
const BASE = args.base || "http://localhost:3111";
const ROLE = args.role || "va";
const OUT = args.out || "var/qa";
const PASSWORD = args.password || "alphaos123";
const USERS = { admin: "admin@aystudios.io", va: "va1@aystudios.io", designer: "d1@aystudios.io" };
const DEFAULT_PAGES = {
  admin: ["/dashboard", "/orders", "/queue", "/board", "/emails", "/customers", "/designers", "/styles", "/payouts", "/queue/print", "/health", "/settings"],
  va: ["/dashboard", "/orders", "/queue", "/board", "/emails", "/customers", "/queue/print", "/orders/new"],
  designer: ["/board"],
};
const pages = args.pages ? String(args.pages).split(",") : DEFAULT_PAGES[ROLE];
const DESKTOP_WIDTH = args.width ? Number(args.width) : 1440;
const VIEWPORTS = { desktop: { width: DESKTOP_WIDTH, height: 900 }, phone: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } };

fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: "chrome" });
const results = [];
for (const [kind, vp] of Object.entries(VIEWPORTS)) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: !!vp.isMobile, hasTouch: !!vp.hasTouch, deviceScaleFactor: vp.deviceScaleFactor || 1 });
  const page = await ctx.newPage();
  const consoleErrors = [];
  const failed = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 300)); });
  page.on("requestfailed", (r) => failed.push(r.url().slice(0, 200)));
  page.on("response", (r) => { if (r.status() >= 500) failed.push(`${r.status()} ${r.url().slice(0, 200)}`); });
  // login
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.fill('input[type="email"], input[name="email"]', USERS[ROLE]);
  await page.fill('input[type="password"], input[name="password"]', PASSWORD);
  await Promise.all([page.waitForNavigation({ waitUntil: "networkidle", timeout: 20000 }).catch(() => {}), page.click('button[type="submit"]')]);
  for (const p of pages) {
    consoleErrors.length = 0; failed.length = 0;
    const t0 = Date.now();
    let status = 0;
    try { const resp = await page.goto(`${BASE}${p}`, { waitUntil: "networkidle", timeout: 30000 }); status = resp?.status() || 0; } catch (e) { consoleErrors.push(`nav: ${e.message.slice(0, 120)}`); }
    await page.waitForTimeout(400);
    // A page mid-navigation (a redirect chain, a 500) can hand evaluate() a
    // torn-down/blank document — one page's bad luck shouldn't crash the
    // whole walk, so this is guarded and defaults to empty metrics on failure.
    const metrics = await page.evaluate(() => {
      const els = [...document.querySelectorAll("a,button,input,select,textarea,[role=button]")].filter((e) => e.getClientRects().length);
      const small = els.filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && (r.width < 40 || r.height < 40); }).length;
      const tiny = [...document.querySelectorAll("body *")].filter((e) => { const s = getComputedStyle(e); return e.childNodes.length && [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) && parseFloat(s.fontSize) < 12; }).length;
      // Inner overflow: any element (the document included) whose content is
      // wider than its own box while overflow-x can't hide it (visible/clip) —
      // that's text or a table spilling out of a card, not a deliberate
      // horizontal-scroll container (overflow-x-auto/scroll are excluded).
      const innerOverflow = [document.documentElement, ...document.querySelectorAll("body *")]
        .filter(Boolean)
        .map((e) => {
          const isDoc = e === document.documentElement;
          const sw = e.scrollWidth;
          const cw = e.clientWidth;
          if (sw <= cw + 2) return null;
          const ov = isDoc ? "visible" : getComputedStyle(e).overflowX;
          if (!isDoc && ov !== "visible" && ov !== "clip") return null;
          return { tag: e.tagName.toLowerCase(), cls: String(e.className || "").slice(0, 40), scrollWidth: sw, clientWidth: cw };
        })
        .filter(Boolean)
        .sort((a, b) => (b.scrollWidth - b.clientWidth) - (a.scrollWidth - a.clientWidth))
        .slice(0, 5);
      return { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth, smallTapTargets: small, textUnder12px: tiny, innerOverflow, title: document.title, h1: document.querySelector("h1")?.textContent?.trim().slice(0, 80) || "", url: location.pathname };
    }).catch((e) => {
      consoleErrors.push(`evaluate: ${e.message.slice(0, 120)}`);
      return { scrollWidth: 0, clientWidth: 0, smallTapTargets: 0, textUnder12px: 0, innerOverflow: [], title: "", h1: "", url: p };
    });
    const file = path.join(OUT, `${ROLE}-${kind}${p.replace(/\W+/g, "_") || "_root"}.png`);
    // The shell pins html/body to the viewport and scrolls inside <main>, so a
    // plain fullPage shot would miss everything below the fold. Expand for the shot only.
    await page.addStyleTag({ content: "html,body,main,[data-scroll-root]{height:auto!important;max-height:none!important;overflow:visible!important}" }).catch(() => {});
    await page.waitForTimeout(150);
    await page.screenshot({ path: file, fullPage: true }).catch((e) => consoleErrors.push(`screenshot: ${e.message.slice(0, 120)}`));
    const row = { role: ROLE, kind, page: p, status, ms: Date.now() - t0, landed: metrics.url, h1: metrics.h1, overflow: metrics.scrollWidth > metrics.clientWidth, innerOverflow: metrics.innerOverflow, smallTapTargets: metrics.smallTapTargets, textUnder12px: metrics.textUnder12px, consoleErrors: [...consoleErrors], failed: [...failed], shot: file };
    results.push(row);
    console.log(JSON.stringify(row));
  }
  await ctx.close();
}
await browser.close();
const bad = results.filter((r) => r.status >= 400 || r.consoleErrors.length || r.failed.length || r.overflow || r.innerOverflow.length);
console.error(`walk done: ${results.length} pages, ${bad.length} with problems`);
