import { promises as fs } from "node:fs";
import path from "node:path";

import {
  headObject as r2Head,
  isR2Configured,
  presignUpload as r2PresignUpload,
} from "@/lib/storage/r2";
import { appUrl } from "@/lib/urls";

/**
 * Where a customer photo lands. In production this is ALWAYS R2 (private
 * bucket, presigned PUT straight from the browser). When the R2 env is absent
 * (local dev) we fall back to a clearly-labelled on-disk store under
 * var/dev-uploads so the whole upload flow can be exercised end to end. The
 * browser code is identical in both modes: it PUTs the bytes to `uploadUrl`.
 *
 * Dev-store assets are still `storage:'r2'` rows whose key starts with
 * DEV_STORE_PREFIX, so they are impossible to confuse with real objects.
 */
export const DEV_STORE_PREFIX = "dev-local/";
const DEV_STORE_DIR = path.join(process.cwd(), "var", "dev-uploads");

export function usingDevStore(): boolean {
  return !isR2Configured();
}

export function isDevStoreKey(key: string): boolean {
  return key.startsWith(DEV_STORE_PREFIX);
}

/** Absolute path of a dev-store object; refuses anything that escapes the dir. */
export function devStorePath(key: string): string {
  const rel = key.slice(DEV_STORE_PREFIX.length);
  const abs = path.join(DEV_STORE_DIR, rel);
  if (!abs.startsWith(DEV_STORE_DIR + path.sep)) throw new Error("bad dev store key");
  return abs;
}

/** A URL the browser can PUT the file to. */
export async function presignPut(opts: { key: string; contentType: string }): Promise<string> {
  if (!usingDevStore()) return r2PresignUpload(opts);
  return appUrl(`/api/upload/dev/${opts.key.slice(DEV_STORE_PREFIX.length)}`);
}

/** Size + type of a stored object, so we never trust the browser's claims. */
export async function headStored(key: string): Promise<{ contentType: string | null; contentLength: number | null }> {
  if (!isDevStoreKey(key)) return r2Head(key);
  const abs = devStorePath(key);
  const [stat, meta] = await Promise.all([
    fs.stat(abs),
    fs.readFile(`${abs}.meta.json`, "utf8").then((s) => JSON.parse(s) as { contentType?: string }).catch(() => ({}) as { contentType?: string }),
  ]);
  return { contentType: meta.contentType ?? null, contentLength: stat.size };
}

/** Write a dev-store object (the PUT route handler). */
export async function writeDevStoreObject(key: string, contentType: string, bytes: Buffer): Promise<void> {
  const abs = devStorePath(key);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, bytes);
  await fs.writeFile(`${abs}.meta.json`, JSON.stringify({ contentType, storedAt: new Date().toISOString() }));
}
