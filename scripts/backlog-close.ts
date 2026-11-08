/**
 * Close the pre-15-Oct backlog as complete (Yousif 2026-11-08: "Also for orders before October 15. Just mark them as
 * complete."). The rules live in lib/orders/backlog-close.ts: no buyer email, no transition chain, live orders stay.
 *
 *   npm run backlog-close                              dry run: what closes, what stays open and why
 *   npm run backlog-close -- --apply                   close the quiet ones (system actor)
 *   --cut <iso>   --live-days 10   --keep PC32217,4205882294   --only <numbers>   --limit N
 *   npm run backlog-close -- --undo <apply report>     put them back
 */
import "./load-env";

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

import {
  backlogClose,
  undoBacklogClose,
  type BacklogRow,
} from "../lib/orders/backlog-close";

const args = process.argv.slice(2);
const val = (flag: string) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const list = (flag: string) =>
  (val(flag) ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
const dir = `${process.env.HOME}/Documents/ai-employee-agent/var/alphaos-backlog-close`;
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

async function main() {
  mkdirSync(dir, { recursive: true });
  const undo = val("--undo");
  if (undo) {
    const report = JSON.parse(readFileSync(undo, "utf8"));
    const res = await undoBacklogClose(report.closed ?? []);
    console.log(`restored ${res.restored.length}; left ${res.left.length}`);
    for (const l of res.left) console.log(`  ${l.number}: ${l.why}`);
    const out = `${dir}/${stamp()}-undo.json`;
    writeFileSync(out, JSON.stringify({ from: undo, ...res }, null, 2));
    console.log(`report: ${out}`);
    return;
  }
  const apply = args.includes("--apply");
  const s = await backlogClose({
    cut: val("--cut"),
    liveDays: val("--live-days") ? Number(val("--live-days")) : undefined,
    keep: list("--keep"),
    only: list("--only"),
    apply,
    limit: val("--limit") ? Number(val("--limit")) : undefined,
  });
  const by = (rows: { status?: string; priorStatus?: string }[]) => {
    const m = new Map<string, number>();
    for (const r of rows)
      m.set(
        r.status ?? r.priorStatus ?? "?",
        (m.get(r.status ?? r.priorStatus ?? "?") ?? 0) + 1,
      );
    return Object.fromEntries([...m.entries()].sort((a, b) => b[1] - a[1]));
  };
  console.log(`open orders placed before ${s.cut}: ${s.open}`);
  console.log(
    `quiet, ${apply ? "closing" : "would close"}: ${s.quiet.length}`,
    by(s.quiet),
  );
  console.log(`live, staying open: ${s.live.length}`, by(s.live));
  const line = (r: BacklogRow) =>
    `  ${r.business} ${r.number} [${r.status}] ${r.live.join("; ")}`;
  for (const r of s.live) console.log(line(r));
  if (s.kept.length)
    console.log(`kept by --keep: ${s.kept.map((r) => r.number).join(", ")}`);
  if (apply) {
    console.log(`closed: ${s.closed.length}`, by(s.closed));
    const earned = s.closed.filter((c) => c.earningId).length;
    console.log(`earnings booked to the first QC pass: ${earned}`);
    for (const c of s.closed.filter((c) =>
      c.earningNote?.startsWith("not booked"),
    ))
      console.log(`  ${c.number}: ${c.earningNote}`);
    for (const k of s.skipped) console.log(`  skipped ${k.number}: ${k.why}`);
  } else console.log("dry run; pass --apply to close them");
  const out = `${dir}/${stamp()}-${apply ? "apply" : "dry"}.json`;
  writeFileSync(out, JSON.stringify(s, null, 2));
  console.log(`report: ${out}`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
