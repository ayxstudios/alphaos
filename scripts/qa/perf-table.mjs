#!/usr/bin/env node
// Markdown before/after tables from scripts/qa/perf.mjs output (docs/PERF.md).
//   node scripts/qa/perf-table.mjs --dir var/perf --profile none|fast3g|slow3g
import { existsSync, readFileSync } from "node:fs";

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
const dir = args.dir || "var/perf";
const profile = args.profile || "none";
const tag = profile === "none" ? "" : `${profile}-`;
const load = (when, role) => {
  const f = `${dir}/${when}-${tag}${role}.json`;
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null;
};
const v = (x) => (x == null || x === 0 ? "-" : String(x));
const pair = (b, a) => `${v(b)} / ${v(a)}`;
// "ready" is null on a page that redirects itself after load (the saved-view
// redirect on /orders, /me for staff); LCP stands in there.
const ready = (m) => (m ? m.ready ?? m.lcp : null);
const short = (p) => (p.startsWith("/orders/") && p.length > 20 ? "/orders/[id]" : p);

const out = [];
for (const role of ["admin", "va", "designer"]) {
  const before = load("before", role);
  const after = load("after", role);
  if (!before || !after) continue;
  const vps = profile === "none" ? ["laptop", "phone"] : ["phone"];
  for (const vp of vps) {
    out.push(`\n**${role}, ${vp}${profile === "none" ? "" : `, ${profile === "fast3g" ? "Fast 3G" : "Slow 3G"}`}** (ms, before / after)\n`);
    if (profile === "none") {
      out.push("| page | TTFB cold | TTFB warm | LCP cold | LCP warm | nav cold | nav warm |");
      out.push("|---|---|---|---|---|---|---|");
    } else {
      out.push("| page | TTFB cold | paint cold | ready cold | TTFB warm | paint warm | ready warm | nav cold | nav warm |");
      out.push("|---|---|---|---|---|---|---|---|---|");
    }
    for (const path of Object.keys(after.pages)) {
      const b = before.pages[path]?.[vp] ?? {};
      const a = after.pages[path]?.[vp] ?? {};
      if (profile === "none") {
        out.push(`| ${short(path)} | ${pair(b.cold?.ttfb, a.cold?.ttfb)} | ${pair(b.warm?.ttfb, a.warm?.ttfb)} | ${pair(b.cold?.lcp, a.cold?.lcp)} | ${pair(b.warm?.lcp, a.warm?.lcp)} | ${pair(b.navCold?.ms, a.navCold?.ms)} | ${pair(b.navWarm?.ms, a.navWarm?.ms)} |`);
      } else {
        out.push(`| ${short(path)} | ${pair(b.cold?.ttfb, a.cold?.ttfb)} | ${pair(b.cold?.fcp, a.cold?.fcp)} | ${pair(ready(b.cold), ready(a.cold))} | ${pair(b.warm?.ttfb, a.warm?.ttfb)} | ${pair(b.warm?.fcp, a.warm?.fcp)} | ${pair(ready(b.warm), ready(a.warm))} | ${pair(b.navCold?.ms, a.navCold?.ms)} | ${pair(b.navWarm?.ms, a.navWarm?.ms)} |`);
      }
    }
  }
}
console.log(out.join("\n"));
