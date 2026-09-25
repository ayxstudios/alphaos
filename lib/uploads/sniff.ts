/**
 * What a file really is, from its first bytes (customer + security QA
 * 2026-09-25). The upload flow already checks the Content-Type stored with the
 * object, but that value is whatever the browser sent with the presigned PUT:
 * a file called photo.png that is really an HTML page, a PDF or a script would
 * pass. This reads the magic bytes and names the image type they belong to, so
 * the save step can refuse anything that is not a real photo before an asset
 * row exists. Pure function, no I/O: SNIFF_BYTES is how much a caller needs.
 */

export const SNIFF_BYTES = 32;

export type SniffedImageType = "image/jpeg" | "image/png" | "image/webp" | "image/gif" | "image/heic" | "image/heif";

/** The image type the bytes prove, or null for anything else (HTML, PDF, text, empty). */
export function sniffImageType(head: Uint8Array): SniffedImageType | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(head, [0x47, 0x49, 0x46, 0x38]) && (head[4] === 0x37 || head[4] === 0x39) && head[5] === 0x61) return "image/gif";
  if (startsWith(head, [0x52, 0x49, 0x46, 0x46]) && ascii(head, 8, 4) === "WEBP") return "image/webp";
  // ISO base media (HEIF family): "ftyp" at byte 4, then the major brand.
  if (head.length >= 12 && ascii(head, 4, 4) === "ftyp") {
    const brand = ascii(head, 8, 4);
    if (["heic", "heix", "hevc", "hevx"].includes(brand)) return "image/heic";
    if (["mif1", "msf1", "heif", "heim", "heis", "avif"].includes(brand)) return "image/heif";
  }
  return null;
}

/** True when the bytes are an image of the family the declared type claims (jpeg is jpeg, heic and heif are one family). */
export function sniffMatchesDeclared(head: Uint8Array, declared: string): boolean {
  const real = sniffImageType(head);
  if (!real) return false;
  const family = (t: string) => (t === "image/heic" || t === "image/heif" ? "heif" : t);
  return family(real) === family(declared.toLowerCase());
}

function startsWith(buf: Uint8Array, bytes: number[]): boolean {
  if (buf.length < bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) if (buf[i] !== bytes[i]) return false;
  return true;
}

function ascii(buf: Uint8Array, at: number, len: number): string {
  if (buf.length < at + len) return "";
  let s = "";
  for (let i = at; i < at + len; i++) s += String.fromCharCode(buf[i]);
  return s;
}
