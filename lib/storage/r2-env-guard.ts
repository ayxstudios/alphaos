/**
 * Scripts load .env.local with dotenv, which never replaces a variable the
 * parent process already set. A tool that keeps its own R2_* settings (for a
 * different bucket) and launches an AlphaOS script therefore makes that script
 * read and write the other bucket without any error: on 2026-10-13 a redrawn
 * portrait was saved into another app's bucket and the order showed a missing
 * file. scripts/load-env.ts records any R2 setting that did not come from
 * .env.local, and every storage call refuses until that is sorted out.
 *
 * The deployed app never runs load-env, so this only ever affects scripts.
 * The bench blanks R2_* on purpose; blank values are not flagged.
 */
export const R2_ENV_KEYS = ["R2_ENDPOINT", "R2_BUCKET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"] as const;

/** Why storage is unsafe for this script, or null. Names keys and buckets only, never a secret. */
export function r2EnvProblem(fromFile: Record<string, string> | undefined, env: Record<string, string | undefined>): string | null {
  if (env.ALPHAOS_R2_FROM_SHELL === "1") return null;
  const keys = R2_ENV_KEYS.filter((k) => env[k] && env[k] !== fromFile?.[k]);
  if (!keys.length) return null;
  const buckets = keys.includes("R2_BUCKET")
    ? ` The parent process says bucket "${env.R2_BUCKET}", this repo's .env.local says ${fromFile?.R2_BUCKET ? `"${fromFile.R2_BUCKET}"` : "nothing"}.`
    : "";
  return (
    `Storage refused: ${keys.join(", ")} came from the parent process, not this repo's .env.local, so files could land in the wrong bucket.${buckets} ` +
    `Rerun with \`env -u ${R2_ENV_KEYS.join(" -u ")}\` to use .env.local, or set ALPHAOS_R2_FROM_SHELL=1 only when the parent's values really are AlphaOS storage.`
  );
}

let problem: string | null = null;

/** Called by scripts/load-env.ts once .env.local is loaded. */
export function noteR2EnvSource(fromFile: Record<string, string> | undefined, env: Record<string, string | undefined> = process.env): void {
  problem = r2EnvProblem(fromFile, env);
}

/** Throws when this script's storage settings did not come from .env.local. */
export function assertR2EnvSource(): void {
  if (problem) throw new Error(problem);
}
