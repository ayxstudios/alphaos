#!/usr/bin/env node
// Public-page screenshot (no login): node scripts/qa/shot.mjs <url> <outPrefix>
import { createRequire } from "node:module";
const require = createRequire("/Users/almacorp2/Documents/ai-employee-agent/package.json");
const { chromium } = require("patchright");
const [url, out] = process.argv.slice(2);
const browser = await chromium.launch({ headless: true, channel: "chrome" });
for (const [kind, vp] of Object.entries({ desktop: { width: 1440, height: 900 }, phone: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } })) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: !!vp.isMobile, hasTouch: !!vp.hasTouch, deviceScaleFactor: vp.deviceScaleFactor || 1 });
  const page = await ctx.newPage();
  const errs = [];
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text().slice(0, 200)); });
  const resp = await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(400);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  await page.screenshot({ path: `${out}-${kind}.png`, fullPage: true });
  console.log(JSON.stringify({ kind, status: resp?.status(), overflow, errs }));
  await ctx.close();
}
await browser.close();
