#!/usr/bin/env node
// Where does TTFB go? (docs/PERF.md). Warm keep-alive connection, N samples each:
//   floor   = /api/health (function in iad1, no middleware, no database)
//   edge    = a protected page with no cookie (middleware answers 307 at the edge)
//   page    = signed-in HTML GET and RSC GET (client navigation) of a page
//
//   node scripts/qa/ttfb-probe.mjs --base <url> --role admin --paths /help,/payouts [--n 6]
import { createRequire } from "node:module";
const require = createRequire("/Users/almacorp2/Documents/ai-employee-agent/package.json");
const { chromium } = require("playwright");

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
const base = args.base.replace(/\/$/, "");
const n = Number(args.n || 6);
const role = args.role || "admin";
const paths = (args.paths || "/help").split(",");

const browser = await chromium.launch({ headless: true, channel: "chrome" });
const ctx = await browser.newContext();
const page = await ctx.newPage();
await page.goto(`${base}/login`);
await page.fill('input[type="email"], input[name="email"]', process.env[`STAGING_${role.toUpperCase()}_EMAIL`]);
await page.fill('input[type="password"], input[name="password"]', process.env[`STAGING_${role.toUpperCase()}_PASSWORD`]);
await Promise.all([page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60000 }), page.click('button[type="submit"]')]);
const cookie = (await ctx.cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
await browser.close();

async function time(url, headers = {}) {
  const t0 = performance.now();
  const res = await fetch(url, { headers, redirect: "manual" });
  const ttfb = performance.now() - t0;
  await res.arrayBuffer();
  return { ttfb: Math.round(ttfb), total: Math.round(performance.now() - t0), status: res.status, id: res.headers.get("x-vercel-id") };
}
const med = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
async function probe(label, url, headers) {
  const s = [];
  for (let i = 0; i < n; i++) s.push(await time(url, headers));
  const warm = s.slice(1);
  console.log(`${label.padEnd(34)} ttfb med ${String(med(warm.map((x) => x.ttfb))).padStart(4)} min ${String(Math.min(...warm.map((x) => x.ttfb))).padStart(4)} | total med ${String(med(warm.map((x) => x.total))).padStart(4)} | ${s[0].status} ${s[0].id?.split("::").slice(0, 2).join("::")}`);
}
await probe("floor /api/health", `${base}/api/health`);
await probe("edge 307 /dashboard (no cookie)", `${base}/dashboard`);
for (const p of paths) {
  await probe(`html ${p}`, base + p, { cookie });
  await probe(`rsc  ${p}`, base + p, { cookie, RSC: "1" });
}
