// Runs every `test:*` script in package.json one after another (they share one
// database, so never in parallel), prints a table and one summary line, and
// exits non-zero when any suite fails. Usage: npm run test:all [-- name ...]
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const only = process.argv.slice(2);
const suites = Object.keys(pkg.scripts)
  .filter((k) => k.startsWith("test:") && k !== "test:all" && k !== "test:tour")
  .filter((k) => only.length === 0 || only.includes(k) || only.includes(k.slice(5)));

const rows = [];
for (const name of suites) {
  console.log(`\n===== ${name}`);
  const t0 = Date.now();
  const r = spawnSync("npm", ["run", "-s", name], { stdio: "inherit", env: process.env });
  rows.push({ name, ok: r.status === 0, secs: ((Date.now() - t0) / 1000).toFixed(1) });
}

const failed = rows.filter((r) => !r.ok);
console.log("\nsuite                     result  time");
for (const r of rows) {
  console.log(`${r.name.padEnd(26)}${(r.ok ? "PASS" : "FAIL").padEnd(8)}${r.secs}s`);
}
console.log(
  `\ntest:all ${failed.length ? "FAILED" : "OK"}: ${rows.length - failed.length}/${rows.length} passed` +
    (failed.length ? ` (failed: ${failed.map((r) => r.name).join(", ")})` : ""),
);
process.exit(failed.length ? 1 : 0);
