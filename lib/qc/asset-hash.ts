import { imageHashOf, type ImageHash } from "@/lib/qc/image-hash";
import { readStoredObject } from "@/lib/uploads/store";

/** The columns a new assets row gets for the wrong-file stop; all null when the file cannot be hashed. */
export type HashColumns = { dhash: string | null; width: number | null; height: number | null; fineSig: string | null };

const NONE: HashColumns = { dhash: null, width: null, height: null, fineSig: null };
const MAX_BYTES = 30 * 1024 * 1024;

function columns(h: ImageHash | null): HashColumns {
  return h ? { dhash: h.dhash, width: h.width, height: h.height, fineSig: h.fineSig } : NONE;
}

/** Bytes of an uploaded or linked file, or null when it cannot be read in time. */
export async function readAssetBytes(a: { storage: string; url?: string | null; r2Key?: string | null }): Promise<Buffer | null> {
  try {
    if (a.storage === "r2" && a.r2Key) return await readStoredObject(a.r2Key);
    if (a.storage === "cdn" && a.url && /^https?:\/\//i.test(a.url)) {
      const res = await fetch(a.url, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) return null;
      const len = Number(res.headers.get("content-length") ?? 0);
      if (len > MAX_BYTES) return null;
      return Buffer.from(await res.arrayBuffer());
    }
  } catch {
    // unreadable now: left unhashed, never an error for the upload itself
  }
  return null;
}

/** Hash columns for one stored file. Best effort: never throws, never blocks an upload. */
export async function hashColumnsFor(a: { storage: string; url?: string | null; r2Key?: string | null }): Promise<HashColumns> {
  const bytes = await readAssetBytes(a);
  return bytes ? columns(await imageHashOf(bytes)) : NONE;
}

/** Hash columns for many R2 keys at once (a board upload of several portraits), keyed by r2 key. */
export async function hashColumnsForKeys(keys: string[]): Promise<Map<string, HashColumns>> {
  const out = new Map<string, HashColumns>();
  await Promise.all(keys.map(async (k) => out.set(k, await hashColumnsFor({ storage: "r2", r2Key: k }))));
  return out;
}
