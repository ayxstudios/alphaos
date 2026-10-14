import { createHash } from "node:crypto";

import { eq } from "drizzle-orm";

import type { Tx } from "@/lib/db";
import { assets } from "@/lib/db/schema";
import { getObjectBuffer, headObject } from "@/lib/storage/r2";
import type { OutgoingAttachment } from "@/lib/integrations/gmail/mime";

export type EmailAttachmentDescriptor = {
  assetId: string;
  filename: string;
  contentType: string;
  sizeBytes: number | null;
  fingerprint: string | null;
  url: string | null;
};

function extFromContentType(contentType: string): string {
  if (/png/i.test(contentType)) return "png";
  if (/webp/i.test(contentType)) return "webp";
  if (/gif/i.test(contentType)) return "gif";
  if (/hei[cf]/i.test(contentType)) return "heic";
  return "jpg";
}

/** "Northlight Portraits" -> "Northlight-Portraits"; "PixArt" stays "PixArt". */
function attachmentPrefix(businessName?: string | null): string {
  const slug = (businessName ?? "").normalize("NFKD").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "AlphaOS";
}

export async function describeAssetAttachment(
  tx: Tx,
  assetId: string,
  orderNumber: string,
  businessName?: string | null,
): Promise<EmailAttachmentDescriptor | null> {
  const [asset] = await tx
    .select({
      id: assets.id,
      storage: assets.storage,
      url: assets.url,
      r2Key: assets.r2Key,
    })
    .from(assets)
    .where(eq(assets.id, assetId))
    .limit(1);
  if (!asset) return null;

  if (asset.storage === "r2" && asset.r2Key) {
    const head = await headObject(asset.r2Key);
    const contentType = head.contentType ?? "image/jpeg";
    return {
      assetId: asset.id,
      filename: `${attachmentPrefix(businessName)}-${orderNumber}.${extFromContentType(contentType)}`,
      contentType,
      sizeBytes: head.contentLength,
      fingerprint: head.eTag,
      url: null,
    };
  }

  if (asset.url) {
    const res = await fetch(asset.url, { method: "HEAD" }).catch(() => null);
    const contentType = res?.headers.get("content-type") ?? "image/jpeg";
    const len = res?.headers.get("content-length");
    return {
      assetId: asset.id,
      filename: `${attachmentPrefix(businessName)}-${orderNumber}.${extFromContentType(contentType)}`,
      contentType,
      sizeBytes: len ? Number(len) : null,
      fingerprint: res?.headers.get("etag") ?? null,
      url: asset.url,
    };
  }

  return null;
}

/**
 * The most files one proof email may carry. Gmail's limit (36.7 MB) is for
 * the encoded message, and base64 grows files by about a third.
 */
export const MAX_EMAIL_ATTACHMENT_BYTES = 24 * 1024 * 1024;

export type ProofAttachment = EmailAttachmentDescriptor & { n: number; label: string };

/**
 * Every file a proof email carries, in portrait order. One file keeps today's
 * name ("Shop-1234.jpg"); 2+ files are numbered by portrait
 * ("Shop-1234-portrait-2.jpg") so the customer can tell them apart. Null when
 * any file cannot be opened: an email never goes out short of a portrait. The
 * fingerprint is the file's own for one file, else one over the whole set, so
 * it changes when any file is added, swapped or re-uploaded.
 */
export async function describeProofAttachments(
  tx: Tx,
  files: { assetId: string; n: number; label: string }[],
  orderNumber: string,
  businessName?: string | null,
): Promise<{ files: ProofAttachment[]; fingerprint: string | null; totalBytes: number | null } | null> {
  if (!files.length) return null;
  const described = await Promise.all(files.map((f) => describeAssetAttachment(tx, f.assetId, orderNumber, businessName)));
  const out: ProofAttachment[] = [];
  for (const [i, d] of described.entries()) {
    if (!d) return null;
    const { n, label } = files[i];
    out.push({ ...d, n, label, filename: files.length > 1 ? d.filename.replace(/(\.[A-Za-z0-9]+)$/, `-portrait-${n}$1`) : d.filename });
  }
  const fingerprint =
    out.length === 1
      ? out[0].fingerprint
      : createHash("sha256")
          .update(out.map((d) => `${d.n}:${d.assetId}:${d.fingerprint ?? ""}`).join("|"))
          .digest("hex")
          .slice(0, 32);
  const totalBytes = out.every((d) => d.sizeBytes != null) ? out.reduce((sum, d) => sum + (d.sizeBytes ?? 0), 0) : null;
  return { files: out, fingerprint, totalBytes };
}

export async function loadAssetAttachment(
  tx: Tx,
  assetId: string,
  filename: string | null,
  contentType: string | null,
): Promise<OutgoingAttachment | null> {
  const [asset] = await tx
    .select({
      id: assets.id,
      storage: assets.storage,
      url: assets.url,
      r2Key: assets.r2Key,
    })
    .from(assets)
    .where(eq(assets.id, assetId))
    .limit(1);
  if (!asset) return null;

  if (asset.storage === "r2" && asset.r2Key) {
    const [head, content] = await Promise.all([headObject(asset.r2Key), getObjectBuffer(asset.r2Key)]);
    return {
      filename: filename ?? `portrait.${extFromContentType(head.contentType ?? contentType ?? "image/jpeg")}`,
      contentType: contentType ?? head.contentType ?? "image/jpeg",
      content,
    };
  }

  if (asset.url) {
    const res = await fetch(asset.url);
    if (!res.ok) throw new Error(`Could not fetch attachment asset: ${res.status}`);
    const content = Buffer.from(await res.arrayBuffer());
    return {
      filename: filename ?? `portrait.${extFromContentType(contentType ?? res.headers.get("content-type") ?? "image/jpeg")}`,
      contentType: contentType ?? res.headers.get("content-type") ?? "image/jpeg",
      content,
    };
  }

  return null;
}
