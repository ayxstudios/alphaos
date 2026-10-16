import sharp from "sharp";

/**
 * Wrong-file stop (16 Oct 2026): two looks that must agree before AlphaOS says
 * "this upload is the same picture as that other file" without a person looking
 * (samePicture below).
 *
 * 1. dHash, a 64-bit difference hash: the image shrunk to 9x8 greyscale, each of
 *    the 8 rows contributing 8 bits (1 when a pixel is brighter than its
 *    right-hand neighbour). A resized, recompressed or re-exported copy lands
 *    within a few bits; a different picture is typically 20+ bits away. Cheap to
 *    store and scan, but coarse: on a shared paper texture (CPS watercolours) the
 *    9x8 thumbnail is mostly paper, and about 28% of real uploads landed within
 *    10 bits of some other order's art.
 * 2. The fine signature, a 64x80 greyscale thumbnail, confirms a dHash match on
 *    the drawing itself: inkDifference is the share of inked pixels that differ.
 *    Measured on production files: copies, resizes and re-encodes under 0.01, a
 *    1% crop 0.15, a changed name band 0.12; different pictures on the same
 *    paper 0.34 and up.
 */

export const DHASH_W = 9;
export const DHASH_H = 8;
/** Hamming distance at or under which two files may be the same picture (the first look). */
export const SAME_PICTURE_DISTANCE = 10;

export const FINE_W = 64;
export const FINE_H = 80;
const FINE_PREFIX = "g64x80:";
/** Share of inked pixels that may differ while two files are still the same picture (the second look). */
export const SAME_PICTURE_INK_DIFF = 0.2;
/** Grey levels away from a file's paper colour that count as ink. */
const INK_LEVEL = 20;
/** Grey levels two inked pixels may differ by and still agree. */
const INK_TOLERANCE = 32;
/** Under this share of inked pixels there is nothing to compare (a blank page): never a match. */
const MIN_INK_SHARE = 0.01;

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

/** Fine signature from 5120 greyscale bytes (64 wide, 80 tall, row by row): "g64x80:" + base64. */
export function fineSigFromGray(gray: ArrayLike<number>): string {
  if (gray.length < FINE_W * FINE_H) throw new Error("fine signature needs 64x80 grey pixels");
  return FINE_PREFIX + Buffer.from(Array.from({ length: FINE_W * FINE_H }, (_, i) => gray[i])).toString("base64");
}

function finePixels(sig: string | null | undefined): Uint8Array | null {
  if (!sig || !sig.startsWith(FINE_PREFIX)) return null;
  const px = Buffer.from(sig.slice(FINE_PREFIX.length), "base64");
  return px.length === FINE_W * FINE_H ? px : null;
}

/** The paper colour: median grey of the outer 2-pixel ring. */
function paperOf(px: Uint8Array): number {
  const ring: number[] = [];
  for (let y = 0; y < FINE_H; y++) {
    for (let x = 0; x < FINE_W; x++) {
      if (x < 2 || y < 2 || x >= FINE_W - 2 || y >= FINE_H - 2) ring.push(px[y * FINE_W + x]);
    }
  }
  ring.sort((a, b) => a - b);
  return ring[ring.length >> 1];
}

/**
 * How different the drawing in two files is, 0 (the same) to 1: of the pixels
 * that carry ink in either file (more than INK_LEVEL grey levels off that file's
 * own paper colour), the share whose ink differs by more than INK_TOLERANCE.
 * Measured from each file's paper, so a brighter or toned export of the same
 * file stays the same picture. Null when either signature is missing or there is
 * almost no ink to compare: nothing to judge, so never a match.
 */
export function inkDifference(a: string | null | undefined, b: string | null | undefined): number | null {
  const pa = finePixels(a);
  const pb = finePixels(b);
  if (!pa || !pb) return null;
  const paperA = paperOf(pa);
  const paperB = paperOf(pb);
  let inked = 0;
  let differ = 0;
  for (let i = 0; i < pa.length; i++) {
    const da = pa[i] - paperA;
    const db = pb[i] - paperB;
    if (Math.abs(da) > INK_LEVEL || Math.abs(db) > INK_LEVEL) {
      inked++;
      if (Math.abs(da - db) > INK_TOLERANCE) differ++;
    }
  }
  return inked >= pa.length * MIN_INK_SHARE ? differ / inked : null;
}

export type PictureSig = { dhash: string | null | undefined; fineSig?: string | null };

/**
 * Both looks agree the two files are the same picture: dHash within
 * SAME_PICTURE_DISTANCE bits AND ink within SAME_PICTURE_INK_DIFF. Null when
 * they are not, or when either look is missing (never a block on a guess).
 */
export function samePicture(a: PictureSig, b: PictureSig): { distance: number; inkDiff: number } | null {
  const distance = hamming(a.dhash, b.dhash);
  if (distance > SAME_PICTURE_DISTANCE) return null;
  const inkDiff = inkDifference(a.fineSig, b.fineSig);
  if (inkDiff === null || inkDiff > SAME_PICTURE_INK_DIFF) return null;
  return { distance, inkDiff };
}

export type ImageHash = { dhash: string; width: number; height: number; fineSig: string | null };

/** The fine signature of an image's bytes, or null when it cannot be made. */
async function fineSigOf(bytes: Buffer): Promise<string | null> {
  try {
    const { data, info } = await sharp(bytes, { failOn: "none" })
      .rotate()
      .flatten({ background: "#ffffff" })
      .greyscale()
      .resize(FINE_W, FINE_H, { fit: "fill" })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const step = info.channels || 1;
    if (data.length < FINE_W * FINE_H * step) return null;
    return fineSigFromGray(step === 1 ? data : Array.from({ length: FINE_W * FINE_H }, (_, i) => data[i * step]));
  } catch {
    return null;
  }
}

/**
 * Hash, fine signature and size of an image's bytes (size after EXIF rotation).
 * Null for anything sharp cannot decode (PDF, HEIC without libheif, a corrupt
 * file): those are simply not hashed and never blocked.
 */
export async function imageHashOf(bytes: Buffer): Promise<ImageHash | null> {
  try {
    const meta = await sharp(bytes, { failOn: "none" }).metadata();
    if (!meta.width || !meta.height) return null;
    const swap = (meta.orientation ?? 1) >= 5;
    const width = swap ? meta.height : meta.width;
    const height = swap ? meta.width : meta.height;
    const [raw, fineSig] = await Promise.all([
      sharp(bytes, { failOn: "none" })
        .rotate()
        .flatten({ background: "#ffffff" })
        .greyscale()
        .resize(DHASH_W, DHASH_H, { fit: "fill" })
        .raw()
        .toBuffer(),
      fineSigOf(bytes),
    ]);
    return { dhash: dhashFromGray(raw), width, height, fineSig };
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
