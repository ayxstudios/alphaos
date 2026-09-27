/**
 * Deterministic image picker for the demo seed fixtures (docs/DEMO.md).
 *
 * Reads public/demo/manifest.json (written by scripts/demo/build-manifest.mjs)
 * when SEED_IMAGE_MANIFEST=1 or the file exists, and picks a stable photo/art
 * URL per order id (same order id always picks the same image, regardless of
 * run order). Falls back to picsum.photos when the manifest is missing or
 * empty, exactly like the fixture did before the demo work.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..");
const manifestPath = join(repoRoot, "public", "demo", "manifest.json");

export type DemoManifest = {
  base: string;
  photos: string[];
  art: Record<string, string[]>;
  /** art path -> the photo path it was drawn from */
  pairs?: Record<string, string>;
};

// Maps the style names used in scripts/seed.ts / order_items.style to the
// manifest's art keys (see scripts/demo/build-manifest.mjs).
const STYLE_TO_ART_KEY: Record<string, string> = {
  cartoon: "cartoon",
  watercolor: "watercolor",
  renaissance: "renaissance",
  "line-art": "lineart",
  lineart: "lineart",
};

let cached: DemoManifest | null | undefined;

function loadManifest(): DemoManifest | null {
  if (cached !== undefined) return cached;
  const enabled = process.env.SEED_IMAGE_MANIFEST === "1" || existsSync(manifestPath);
  if (!enabled) {
    cached = null;
    return cached;
  }
  if (!existsSync(manifestPath)) {
    console.warn(`SEED_IMAGE_MANIFEST=1 but ${manifestPath} does not exist; falling back to picsum.`);
    cached = null;
    return cached;
  }
  try {
    const raw = readFileSync(manifestPath, "utf8");
    const parsed = JSON.parse(raw) as DemoManifest;
    cached = parsed;
  } catch (err) {
    console.warn(`Could not parse ${manifestPath}, falling back to picsum:`, err);
    cached = null;
  }
  return cached;
}

/** FNV-1a: same function used elsewhere in the seed scripts, kept local so this module has no cross-file coupling. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function absolute(manifest: DemoManifest, path: string): string {
  if (/^https?:\/\//.test(path)) return path;
  const base = manifest.base.replace(/\/$/, "");
  return `${base}${path}`;
}

/**
 * Deterministic photo URL for an order id. Returns null when the manifest is
 * disabled/missing/empty so the caller can fall back to picsum.
 */
export function demoPhotoUrl(orderId: string): string | null {
  const manifest = loadManifest();
  if (!manifest || manifest.photos.length === 0) return null;
  const pick = manifest.photos[hash(orderId) % manifest.photos.length];
  return absolute(manifest, pick);
}

/**
 * Deterministic art (finished-portrait style) URL for an order id, preferring
 * the given product style when it is known and has images in the manifest;
 * otherwise picks from any style that has images. Returns null when the
 * manifest is disabled/missing/empty (all styles empty) so the caller can
 * fall back to picsum.
 */
export function demoArtUrl(orderId: string, style?: string | null): string | null {
  const manifest = loadManifest();
  if (!manifest) return null;
  const artKey = style ? STYLE_TO_ART_KEY[style] : undefined;
  let pool = artKey ? manifest.art[artKey] ?? [] : [];
  if (pool.length === 0) {
    // No images for the requested style (or no known style): use any style
    // that has images, so a partially-generated manifest still works.
    pool = Object.values(manifest.art).flat();
  }
  if (pool.length === 0) return null;
  const pick = pool[hash(orderId) % pool.length];
  return absolute(manifest, pick);
}

export function isManifestActive(): boolean {
  return loadManifest() !== null;
}

/** Absolute photo URLs for a subject kind ("pet" | "people"), or all photos for "any". */
export function demoPhotoPool(kind: "pet" | "people" | "any"): string[] {
  const manifest = loadManifest();
  if (!manifest) return [];
  const all = manifest.photos.map((p) => absolute(manifest, p));
  if (kind === "any") return all;
  const sub = all.filter((u) => u.includes(`/${kind}-`));
  return sub.length ? sub : all;
}

/** The photo an art image was drawn from (absolute URLs in, absolute URL out), or null when unpaired. */
export function demoPairedPhoto(artUrl: string): string | null {
  const manifest = loadManifest();
  if (!manifest?.pairs) return null;
  const path = artUrl.replace(/^https?:\/\/[^/]+/, "");
  const photo = manifest.pairs[path];
  return photo ? absolute(manifest, photo) : null;
}
