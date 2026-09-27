#!/usr/bin/env node
/**
 * Scans public/demo/photos and public/demo/art for finished demo images and
 * writes public/demo/manifest.json (docs/DEMO.md). Safe to re-run any time;
 * it only reads the filesystem and overwrites the manifest file.
 *
 * Photos: public/demo/photos/*.{png,jpg} -> manifest.photos (any subject, any name).
 * Art: public/demo/art/<style>-NN.{png,jpg} -> manifest.art[<style>], where <style>
 * is one of cartoon, watercolor, renaissance, lineart (matches the seeded
 * portrait styles in scripts/seed.ts, with "line-art" mapped to "lineart").
 *
 * Usage: node scripts/demo/build-manifest.mjs
 * Env:   DEMO_ALIAS (default alphaos-demo.vercel.app) sets manifest.base.
 */
import { readdirSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..");
const demoDir = join(repoRoot, "public", "demo");
const photosDir = join(demoDir, "photos");
const artDir = join(demoDir, "art");

const ART_STYLES = ["cartoon", "watercolor", "renaissance", "lineart"];

function listPngs(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.toLowerCase().match(/\.(png|jpe?g)$/))
    .sort();
}

const photos = listPngs(photosDir).map((f) => `/demo/photos/${f}`);

const artFiles = listPngs(artDir);
const art = {};
for (const style of ART_STYLES) {
  const prefix = `${style}-`;
  art[style] = artFiles.filter((f) => f.startsWith(prefix)).map((f) => `/demo/art/${f}`);
}

const base = (process.env.DEMO_ALIAS ?? "alphaos-demo.vercel.app").replace(/^https?:\/\//, "");
const manifest = {
  base: `https://${base}`,
  photos,
  art,
};

writeFileSync(join(demoDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

const artTotal = Object.values(art).reduce((n, list) => n + list.length, 0);
console.log(`Wrote public/demo/manifest.json: ${photos.length} photo(s), ${artTotal} art image(s) across ${ART_STYLES.length} style(s).`);
for (const style of ART_STYLES) {
  console.log(`  ${style}: ${art[style].length}`);
}
if (photos.length === 0) {
  console.log("No photos found yet; seed-qc.ts will fall back to picsum until public/demo/photos has files.");
}
