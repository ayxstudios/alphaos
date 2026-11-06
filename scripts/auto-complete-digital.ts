/**
 * Backfill / manual sweep: approved all-digital orders close as complete
 * (Yousif 2026-11-06, "Autocomplete digital orders once the buyer approves").
 * New approvals close themselves inside the transition; the nightly retention
 * cron runs the same sweep (lib/orders/auto-complete.ts closeApprovedDigital)
 * for anything held, e.g. an order whose figure count was set later.
 *
 *   npm run auto-complete-digital             dry run: counts + the held-risk list
 *   npm run auto-complete-digital -- --apply   close them (system actor)
 *   --limit N   stop after N closes      --business <name fragment>  one shop only
 */
import "./load-env";

import { mkdirSync, writeFileSync } from "node:fs";

import { closeApprovedDigital } from "../lib/orders/auto-complete";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const limitAt = args.indexOf("--limit");
const bizAt = args.indexOf("--business");

async function main() {
  const summary = await closeApprovedDigital({
    limit: apply ? (limitAt >= 0 ? Number(args[limitAt + 1]) : undefined) : 0,
    businessFilter: bizAt >= 0 ? String(args[bizAt + 1]) : null,
  });
  const byBiz = (list: { business: string }[]) => {
    const m = new Map<string, number>();
    for (const r of list) m.set(r.business, (m.get(r.business) ?? 0) + 1);
    return Object.fromEntries([...m.entries()].sort((a, b) => b[1] - a[1]));
  };
  console.log(`approved orders: ${summary.approved}; all-digital, nothing at a printer: ${summary.eligible}; stay approved (physical line or print job): ${summary.stayed}`);
  if (apply) {
    console.log(`closed: ${summary.closed.length}`, byBiz(summary.closed));
    console.log(`held: ${summary.held.length}`, byBiz(summary.held));
    for (const h of summary.held) console.log(`  ${h.business} ${h.number}: ${h.reason}`);
  } else {
    console.log("dry run; pass --apply to close them");
  }
  const dir = `${process.env.HOME}/Documents/ai-employee-agent/var/alphaos-auto-complete`;
  mkdirSync(dir, { recursive: true });
  const out = `${dir}/${new Date().toISOString().replace(/[:.]/g, "-")}-${apply ? "apply" : "dry"}.json`;
  writeFileSync(out, JSON.stringify({ apply, ...summary }, null, 2));
  console.log(`report: ${out}`);
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
