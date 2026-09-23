#!/usr/bin/env node
// Database round trips per page (docs/PERF.md). Pair with a server started
// with DB_TRACE=1 (lib/db trace hook, local only): this signs in, then GETs
// each page one at a time with a quiet gap, and prints the server log lines
// that fall inside each request, so every page's queries can be counted.
//
//   node scripts/qa/trace-pages.mjs --base http://localhost:3917 --role admin --order <id> --log var/perf/trace-server.log
import { createRequire } from "node:module";
import { readFileSync, statSync } from "node:fs";

const require = createRequire("/Users/almacorp2/Documents/ai-employee-agent/package.json");
const { chromium } = require("playwright");

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const base = args.base;
const role = args.role;
const log = args.log;
const email = process.env[`STAGING_${role.toUpperCase()}_EMAIL`];
const password = process.env[`STAGING_${role.toUpperCase()}_PASSWORD`];
const ALL = ["/dashboard", "/today", "/orders", `/orders/${args.order}`, "/qc", "/emails", "/board", "/queue/print", "/payouts", "/settings", "/designers", "/styles", "/health", "/customers", "/me", "/help"];
const pages = role === "designer" ? ["/dashboard", "/board", `/orders/${args.order}`, "/me", "/help"] : role === "va" ? ALL.filter((p) => !["/payouts", "/health"].includes(p)) : ALL;

const browser = await chromium.launch({ headless: true, channel: "chrome" });
const ctx = await browser.newContext();
const page = await ctx.newPage();
await page.goto(`${base}/login`);
await page.fill('input[type="email"], input[name="email"]', email);
await page.fill('input[type="password"], input[name="password"]', password);
await Promise.all([page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60000 }), page.click('button[type="submit"]')]);
const cookie = (await ctx.cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
await browser.close();

const summary = [];
for (const path of pages) {
  for (const mode of ["html", "rsc"]) {
    await new Promise((r) => setTimeout(r, 1500));
    const offset = statSync(log).size;
    const t0 = Date.now();
    const headers = { cookie };
    if (mode === "rsc") Object.assign(headers, { RSC: "1", "Next-Router-State-Tree": encodeURIComponent(JSON.stringify(["", { children: ["(app)", { children: ["__PAGE__", {}] }] }, null, null, true])) });
    const res = await fetch(base + path, { headers, redirect: "manual" });
    const ttfb = Date.now() - t0;
    await res.text();
    const total = Date.now() - t0;
    await new Promise((r) => setTimeout(r, 400));
    const lines = readFileSync(log, "utf8").slice(offset).split("\n").filter((l) => l.startsWith("[db]"));
    const queries = lines.filter((l) => / (ws|http) /.test(l) && !/ ws \d+ms (begin|commit|rollback)/i.test(l) && !/set_config/.test(l));
    const txs = lines.filter((l) => / ws \d+ms begin/i.test(l)).length;
    const http = lines.filter((l) => / http /.test(l)).length;
    const connects = lines.filter((l) => l.includes("connect")).length;
    summary.push({ path, mode, status: res.status, ttfb, total, roundTrips: lines.length - connects, queries: queries.length, txs, http, connects });
    if (mode === "html") {
      console.log(`\n=== ${role} ${path} ${res.status} ttfb=${ttfb} total=${total}`);
      console.log(lines.join("\n"));
    }
  }
}
console.log("\nSUMMARY");
console.table(summary);
