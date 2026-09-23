#!/usr/bin/env node
// What a cold page load downloads, by type and by file (docs/PERF.md).
//   node scripts/qa/resources.mjs --base <url> --role designer --paths /dashboard,/board [--phone]
import { createRequire } from "node:module";
const require = createRequire("/Users/almacorp2/Documents/ai-employee-agent/package.json");
const { chromium } = require("playwright");

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
const base = args.base.replace(/\/$/, "");
const role = args.role || "admin";
const phone = process.argv.includes("--phone");
const vp = phone ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 } : { viewport: { width: 1280, height: 800 } };

const browser = await chromium.launch({ headless: true, channel: "chrome" });
const login = await browser.newContext();
const lp = await login.newPage();
await lp.goto(`${base}/login`);
await lp.fill('input[type="email"], input[name="email"]', process.env[`STAGING_${role.toUpperCase()}_EMAIL`]);
await lp.fill('input[type="password"], input[name="password"]', process.env[`STAGING_${role.toUpperCase()}_PASSWORD`]);
await Promise.all([lp.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60000 }), lp.click('button[type="submit"]')]);
const state = await login.storageState();
await login.close();

for (const path of (args.paths || "/dashboard").split(",")) {
  const ctx = await browser.newContext({ ...vp, storageState: state });
  const page = await ctx.newPage();
  await page.goto(base + path, { waitUntil: "load", timeout: 120000 });
  await page.waitForTimeout(1500);
  const rows = await page.evaluate(() =>
    performance.getEntriesByType("resource").map((r) => ({ name: r.name.replace(location.origin, ""), type: r.initiatorType, kb: Math.round((r.transferSize || 0) / 1024), decoded: Math.round((r.decodedBodySize || 0) / 1024), ms: Math.round(r.duration), blocking: r.renderBlockingStatus })),
  );
  const byType = {};
  for (const r of rows) {
    const t = /\.css/.test(r.name) ? "css" : /\.js/.test(r.name) ? "js" : /\.(woff2?|ttf)/.test(r.name) ? "font" : r.type === "img" || /\.(png|jpe?g|webp|avif|gif|svg)/i.test(r.name) ? "image" : r.type;
    byType[t] = byType[t] || { n: 0, kb: 0, decoded: 0 };
    byType[t].n++; byType[t].kb += r.kb; byType[t].decoded += r.decoded;
  }
  console.log(`\n== ${role} ${path} (${phone ? "phone" : "laptop"})`);
  console.table(byType);
  console.log(rows.sort((a, b) => b.kb - a.kb).slice(0, 12).map((r) => `${String(r.kb).padStart(5)} KB  ${r.blocking === "blocking" ? "BLOCKING " : ""}${r.name.slice(0, 140)}`).join("\n"));
  await ctx.close();
}
await browser.close();
