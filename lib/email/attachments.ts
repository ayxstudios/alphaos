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

export async function describeAssetAttachment(
  tx: Tx,
  assetId: string,
  orderNumber: string,
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
      filename: `PixArt-${orderNumber}.${extFromContentType(contentType)}`,
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
      filename: `PixArt-${orderNumber}.${extFromContentType(contentType)}`,
      contentType,
      sizeBytes: len ? Number(len) : null,
      fingerprint: res?.headers.get("etag") ?? null,
      url: asset.url,
    };
  }

  return null;
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
