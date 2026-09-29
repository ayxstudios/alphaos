import { getObjectHead, isR2Configured } from "@/lib/storage/r2";
import type { PrintFile } from "./prepare";

/**
 * Pixel size of the print file for the "Print and ship" card, read from the
 * first bytes only (a ranged read, never the whole 25 MB file). Assets carry
 * no dimensions in the database, so this is best effort: null when the file
 * cannot be reached or the format is not JPEG/PNG/WebP.
 */

export type ImageSize = { width: number; height: number };

const HEAD_BYTES = 128 * 1024;
const FETCH_TIMEOUT_MS = 3000;

/** Width/height from a JPEG, PNG or WebP header. Pure. */
export function imageSizeFromHeader(buf: Buffer): ImageSize | null {
  // PNG: signature then IHDR (width, height as big-endian uint32).
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.toString("ascii", 12, 16) === "IHDR") {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // WebP: RIFF....WEBP then VP8 / VP8L / VP8X.
  if (buf.length >= 30 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    const chunk = buf.toString("ascii", 12, 16);
    if (chunk === "VP8X") return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    if (chunk === "VP8L") {
      const bits = buf.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8 ") return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  // JPEG: walk the segments to the first SOFn marker.
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) return null;
      const marker = buf[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const length = buf.readUInt16BE(i + 2);
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      i += 2 + length;
    }
  }
  return null;
}

async function headBytes(file: PrintFile): Promise<Buffer | null> {
  if (file.storage === "r2" && file.r2Key) {
    if (!isR2Configured()) return null;
    return getObjectHead(file.r2Key, HEAD_BYTES);
  }
  if (file.url) {
    const res = await fetch(file.url, {
      headers: { Range: `bytes=0-${HEAD_BYTES - 1}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cache: "no-store",
    });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer()).subarray(0, HEAD_BYTES);
  }
  return null;
}

export async function probePrintFileSize(file: PrintFile | null): Promise<ImageSize | null> {
  if (!file) return null;
  try {
    const buf = await headBytes(file);
    return buf ? imageSizeFromHeader(buf) : null;
  } catch {
    return null;
  }
}
