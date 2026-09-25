import { ALLOWED_IMAGE_TYPES, MAX_UPLOAD_BYTES } from "@/lib/storage/r2";
import { SNIFF_BYTES, sniffMatchesDeclared } from "./sniff";
import { headStored, readStoredHead } from "./store";

/**
 * Staff and designer upload saves (board card, manual order) trust nothing the
 * browser said (customer + security QA 2026-09-25):
 *  - the key must be one this order's presign could have issued
 *    (`<business>/<order>/<type>/<uuid>.<ext>`), so a caller cannot attach
 *    another order's or another business's stored file to this order;
 *  - the stored object must be a supported photo type, not empty, 25 MB or less;
 *  - its first bytes must prove the type it claims (a .png that is really an
 *    HTML page is refused).
 * Throws an Error with a plain message; callers already show `error.message`.
 */
export function assertKeysBelongTo(keys: string[], prefix: string): void {
  const bad = keys.some((key) => !key.startsWith(prefix) || !/^[A-Za-z0-9-]+\.[A-Za-z0-9]+$/.test(key.slice(prefix.length)));
  if (bad) throw new Error("Upload key does not match this order");
}

export async function assertStoredImage(key: string): Promise<void> {
  const head = await headStored(key).catch(() => {
    throw new Error("A file did not finish uploading. Please add it again.");
  });
  if (!head.contentType || !ALLOWED_IMAGE_TYPES.test(head.contentType)) throw new Error("Uploaded file is not a supported image");
  if (!head.contentLength || head.contentLength <= 0) throw new Error("Uploaded file is empty");
  if (head.contentLength > MAX_UPLOAD_BYTES) throw new Error("Uploaded file is over 25 MB");
  const first = await readStoredHead(key, SNIFF_BYTES).catch(() => {
    throw new Error("A file did not finish uploading. Please add it again.");
  });
  if (!sniffMatchesDeclared(first, head.contentType)) throw new Error("Uploaded file is not a supported image");
}

/** The same checks as a plain message (null when every key and link is fine), for actions that return results instead of throwing. */
export async function referenceUploadProblem(keys: string[], prefix: string, urls: string[] = []): Promise<string | null> {
  // The form only ever sends http(s) links; anything else (javascript:, data:) is refused here too.
  if (urls.some((url) => !/^https?:\/\/[^\s]+$/i.test(url))) return "Photo links must start with https://";
  try {
    assertKeysBelongTo(keys, prefix);
    await Promise.all(keys.map((key) => assertStoredImage(key)));
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "One of the photos could not be checked. Please add it again.";
  }
}
