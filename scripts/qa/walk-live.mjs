#!/usr/bin/env node
// Logged-in screenshots of the live app (2026-09-09): node scripts/qa/walk-live.mjs <baseUrl> <email> <password> <outPrefix>
import { createRequire } from "node:module";
const require = createRequire("/Users/almacorp2/Documents/ai-employee-agent/package.json");
const { chromium } = require("patchright");
const [base, email, password, out] = process.argv.slice(2);
const browser = await chromium.launch({ headless: true, channel: "chrome" });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.goto(`${base}/login`, { waitUntil: "networkidle", timeout: 45000 });
await page.fill('input[type="email"], input[name="email"]', email);
await page.fill('input[type="password"], input[name="password"]', password);
await Promise.all([page.waitForNavigation({ waitUntil: "networkidle", timeout: 45000 }).catch(() => {}), page.click('button[type="submit"]')]);
const results = [];
for (const path of ["/", "/orders", "/settings", "/queue", "/health"]) {
  const resp = await page.goto(`${base}${path}`, { waitUntil: "networkidle", timeout: 45000 }).catch(() => null);
  await page.waitForTimeout(500);
  const name = path === "/" ? "home" : path.slice(1).replace(/\//g, "-");
  await page.screenshot({ path: `${out}-${name}.png`, fullPage: true });
  const text = await page.evaluate(() => document.body.innerText.slice(0, 400).replace(/\s+/g, " "));
  results.push({ path, status: resp?.status() ?? null, url: page.url(), text });
}
console.log(JSON.stringify(results, null, 1));
await browser.close();
