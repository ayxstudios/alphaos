import sharp from "sharp";

/**
 * Wrong-file stop (16 Oct 2026): a 64-bit difference hash (dHash) of an image,
 * so AlphaOS can tell "this upload is the same picture as that other file"
 * without a person looking. The image is shrunk to 9x8 greyscale and each of the
 * 8 rows contributes 8 bits: 1 when a pixel is brighter than its right-hand
 * neighbour. A resized, recompressed or re-exported copy lands within a few
 * bits; a different picture is typically 20+ bits away.
 */

export const DHASH_W = 9;
export const DHASH_H = 8;
/** Hamming distance at or under which two files count as the same picture. */
export const SAME_PICTURE_DISTANCE = 10;

/** dHash from 72 greyscale bytes (9 wide, 8 tall, row by row). 16 lowercase hex chars. */
export function dhashFromGray(gray: ArrayLike<number>): string {
  if (gray.length < DHASH_W * DHASH_H) throw new Error("dhash needs 72 grey pixels");
  let hex = "";
  for (let y = 0; y < DHASH_H; y++) {
    let byte = 0;
    for (let x = 0; x < DHASH_W - 1; x++) {
      byte = (byte << 1) | (gray[y * DHASH_W + x] > gray[y * DHASH_W + x + 1] ? 1 : 0);
    }
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

/** Bits that differ between two 16-char hashes; Infinity when either is not a valid hash. */
export function hamming(a: string | null | undefined, b: string | null | undefined): number {
  if (!a || !b || !/^[0-9a-f]{16}$/.test(a) || !/^[0-9a-f]{16}$/.test(b)) return Infinity;
  let bits = 0;
  for (let i = 0; i < 16; i += 2) {
    let v = parseInt(a.slice(i, i + 2), 16) ^ parseInt(b.slice(i, i + 2), 16);
    while (v) {
      bits += v & 1;
      v >>= 1;
    }
  }
  return bits;
}

export type ImageHash = { dhash: string; width: number; height: number };

/**
 * Hash and size of an image's bytes (size after EXIF rotation). Null for
 * anything sharp cannot decode (PDF, HEIC without libheif, a corrupt file):
 * those are simply not hashed and never blocked.
 */
export async function imageHashOf(bytes: Buffer): Promise<ImageHash | null> {
  try {
    const meta = await sharp(bytes, { failOn: "none" }).metadata();
    if (!meta.width || !meta.height) return null;
    const swap = (meta.orientation ?? 1) >= 5;
    const width = swap ? meta.height : meta.width;
    const height = swap ? meta.width : meta.height;
    const raw = await sharp(bytes, { failOn: "none" })
      .rotate()
      .flatten({ background: "#ffffff" })
      .greyscale()
      .resize(DHASH_W, DHASH_H, { fit: "fill" })
      .raw()
      .toBuffer();
    return { dhash: dhashFromGray(raw), width, height };
  } catch {
    return null;
  }
}

/** portrait = taller than wide by more than 5%, landscape = the reverse, else square-ish. */
export function aspectOf(width: number | null | undefined, height: number | null | undefined): "portrait" | "landscape" | "square" | null {
  if (!width || !height) return null;
  if (height > width * 1.05) return "portrait";
  if (width > height * 1.05) return "landscape";
  return "square";
}
