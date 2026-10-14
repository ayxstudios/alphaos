// Storage settings a script inherits from its parent process must never beat
// this repo's .env.local silently (lib/storage/r2-env-guard.ts). The rules
// first, then a real script run through load-env and lib/storage/r2 with a
// throwaway .env.local. Signing is local, so nothing touches a real bucket.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { R2_ENV_KEYS, r2EnvProblem } from "../lib/storage/r2-env-guard";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
};

const FILE = {
  R2_ENDPOINT: "https://r2.example.invalid",
  R2_BUCKET: "alphaos-test",
  R2_ACCESS_KEY_ID: "file-key",
  R2_SECRET_ACCESS_KEY: "file-secret",
};

function rules() {
  check("nothing set is fine", r2EnvProblem(undefined, {}) === null);
  check("values from .env.local are fine", r2EnvProblem(FILE, { ...FILE }) === null);
  check(
    "the bench's blank R2_* are fine",
    r2EnvProblem(FILE, { R2_ENDPOINT: "", R2_BUCKET: "", R2_ACCESS_KEY_ID: "", R2_SECRET_ACCESS_KEY: "" }) === null,
  );
  const other = r2EnvProblem(FILE, { ...FILE, R2_BUCKET: "ay-icons" }) ?? "";
  check(
    "a different bucket from the parent is refused, naming both buckets",
    other.includes("R2_BUCKET") && other.includes('"ay-icons"') && other.includes('"alphaos-test"'),
    other.slice(0, 90),
  );
  const noFile = r2EnvProblem(undefined, { R2_BUCKET: "ay-icons" }) ?? "";
  check("R2 from the parent with no .env.local is refused", noFile.includes("says nothing"));
  check(
    "ALPHAOS_R2_FROM_SHELL=1 lets the parent's values through",
    r2EnvProblem(FILE, { ...FILE, R2_BUCKET: "ay-icons", ALPHAOS_R2_FROM_SHELL: "1" }) === null,
  );
  const secret = r2EnvProblem(FILE, { ...FILE, R2_SECRET_ACCESS_KEY: "parent-secret" }) ?? "";
  check(
    "a mismatched secret is named but never printed",
    secret.includes("R2_SECRET_ACCESS_KEY") && !secret.includes("parent-secret") && !secret.includes("file-secret"),
  );
}

function scriptRun() {
  const repo = path.resolve(__dirname, "..");
  const dir = mkdtempSync(path.join(tmpdir(), "r2-env-guard-"));
  try {
    writeFileSync(path.join(dir, ".env.local"), Object.entries(FILE).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
    writeFileSync(
      path.join(dir, "probe.ts"),
      [
        `import ${JSON.stringify(path.join(repo, "scripts/load-env"))};`,
        `import { presignUpload } from ${JSON.stringify(path.join(repo, "lib/storage/r2"))};`,
        `(async () => {`,
        `  try { console.log("URL " + new URL(await presignUpload({ key: "probe/x.png", contentType: "image/png" })).pathname); }`,
        `  catch (e) { console.log("ERR " + (e as Error).message); }`,
        `})();`,
      ].join("\n"),
    );
    // Start from this process's env minus any storage settings of its own.
    const base = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !(R2_ENV_KEYS as readonly string[]).includes(k) && k !== "ALPHAOS_R2_FROM_SHELL"),
    );
    const run = (extra: Record<string, string>) => {
      const r = spawnSync(process.execPath, [path.join(repo, "node_modules/tsx/dist/cli.mjs"), "probe.ts"], {
        cwd: dir,
        env: { ...base, ...extra } as NodeJS.ProcessEnv,
        encoding: "utf8",
      });
      const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
      // dotenv prints its own banner; the probe's answer is the URL/ERR line.
      return out.split("\n").find((l) => /^(URL|ERR) /.test(l)) ?? out.trim();
    };

    const own = run({});
    check("a script with no parent R2 uses .env.local's bucket", own.startsWith("URL /alphaos-test/probe/x.png"), own.slice(0, 120));
    const leaked = run({ R2_BUCKET: "ay-icons" });
    check(
      "a script whose parent leaks another bucket refuses storage",
      leaked.startsWith("ERR Storage refused") && leaked.includes('"ay-icons"'),
      leaked.slice(0, 120),
    );
    const meant = run({ R2_BUCKET: "alphaos-other", ALPHAOS_R2_FROM_SHELL: "1" });
    check("the escape hatch uses the parent's bucket", meant.startsWith("URL /alphaos-other/probe/x.png"), meant.slice(0, 120));
    const blank = run({ R2_ENDPOINT: "", R2_BUCKET: "", R2_ACCESS_KEY_ID: "", R2_SECRET_ACCESS_KEY: "" });
    check("blank R2_* from the bench stay blank (storage off, no refusal)", blank.startsWith("ERR R2_ENDPOINT is not set"), blank.slice(0, 120));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

rules();
scriptRun();
console.log(failed ? `\n${failed} check(s) failed` : "\nall r2 env checks passed");
process.exit(failed ? 1 : 0);
