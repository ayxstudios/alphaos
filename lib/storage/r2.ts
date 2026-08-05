import { randomUUID } from "node:crypto";

import {
  S3Client,
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/**
 * Cloudflare R2 (S3-compatible) object storage for VA-uploaded reference photos.
 *
 * The bucket is PRIVATE and stays private. Uploads go direct from the browser via
 * a presigned PUT (bytes never touch our server); reads are served via short-
 * lived presigned GET URLs. Shopify CDN URLs are stored as `storage:'cdn'`
 * references and never copied here — only real uploads consume storage.
 *
 * Env: R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY.
 */

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MB
export const ALLOWED_IMAGE_TYPES = /^image\/(jpeg|png|webp|gif|heic|heif)$/i;

const PUT_TTL_SECONDS = 300; // presigned PUT validity
const GET_TTL_SECONDS = 300; // presigned GET validity (short — bucket is private)

let cached: S3Client | null = null;
function client(): S3Client {
  if (cached) return cached;
  cached = new S3Client({
    region: "auto",
    endpoint: requireEnv("R2_ENDPOINT"),
    forcePathStyle: true,
    credentials: {
      accessKeyId: requireEnv("R2_ACCESS_KEY_ID"),
      secretAccessKey: requireEnv("R2_SECRET_ACCESS_KEY"),
    },
  });
  return cached;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set (R2 storage not configured)`);
  return v;
}

/** True when R2 is configured — lets callers degrade gracefully (URL paste still works). */
export function isR2Configured(): boolean {
  return !!(
    process.env.R2_ENDPOINT &&
    process.env.R2_BUCKET &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY
  );
}

const bucket = () => requireEnv("R2_BUCKET");

const EXT_BY_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/heic": "heic",
  "image/heif": "heif",
};

/** File extension from the original name, falling back to the content type. */
export function extFor(filename: string, contentType: string): string {
  const m = filename.match(/\.([a-z0-9]{1,5})$/i);
  if (m) return m[1].toLowerCase();
  return EXT_BY_TYPE[contentType.toLowerCase()] ?? "bin";
}

/** Key layout: {businessId}/{orderId}/{assetType}/{uuid}.{ext}. */
export function assetKey(
  businessId: string,
  orderId: string,
  assetType: "reference" | "submission" | "final",
  ext: string,
): string {
  return `${businessId}/${orderId}/${assetType}/${randomUUID()}.${ext}`;
}

/** A short-lived presigned PUT the browser uploads to directly. */
export function presignUpload(opts: { key: string; contentType: string }): Promise<string> {
  return getSignedUrl(
    client(),
    new PutObjectCommand({ Bucket: bucket(), Key: opts.key, ContentType: opts.contentType }),
    { expiresIn: PUT_TTL_SECONDS },
  );
}

/** A short-lived presigned GET for reading a private object (thumbnails, previews). */
export function presignGet(key: string, expiresIn = GET_TTL_SECONDS): Promise<string> {
  return getSignedUrl(client(), new GetObjectCommand({ Bucket: bucket(), Key: key }), { expiresIn });
}

/** Hard-delete an object (retention sweep). */
export async function deleteObject(key: string): Promise<void> {
  await client().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
}
