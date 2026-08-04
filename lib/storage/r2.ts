import { randomUUID } from "node:crypto";

import {
  S3Client,
  DeleteObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/**
 * Cloudflare R2 (S3-compatible) object storage for customer-uploaded reference
 * photos. Uploads go DIRECT from the browser via a presigned PUT — bytes never
 * route through our server. Objects are served from the bucket's public custom
 * domain (R2_PUBLIC_URL). Shopify CDN URLs are stored as references and NEVER
 * copied here, so only real uploads consume storage.
 *
 * Env (see .env.local): R2_ENDPOINT, R2_BUCKET_NAME, R2_ACCESS_KEY_ID,
 * R2_SECRET_ACCESS_KEY, R2_PUBLIC_URL.
 */

const UPLOAD_TTL_SECONDS = 300; // presigned PUT validity

let cached: S3Client | null = null;
function client(): S3Client {
  if (cached) return cached;
  const endpoint = requireEnv("R2_ENDPOINT");
  cached = new S3Client({
    region: "auto",
    endpoint,
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
    process.env.R2_BUCKET_NAME &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY &&
    process.env.R2_PUBLIC_URL
  );
}

const bucket = () => requireEnv("R2_BUCKET_NAME");

/** Namespace keys by business + order so retention + access are easy to reason about. */
export function assetKey(businessId: string, orderId: string, filename: string): string {
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-80);
  return `business/${businessId}/order/${orderId}/${randomUUID()}-${safe}`;
}

/** A short-lived presigned PUT the browser uploads to directly. */
export async function presignUpload(opts: {
  key: string;
  contentType: string;
}): Promise<string> {
  return getSignedUrl(
    client(),
    new PutObjectCommand({ Bucket: bucket(), Key: opts.key, ContentType: opts.contentType }),
    { expiresIn: UPLOAD_TTL_SECONDS },
  );
}

/** Public URL for a stored object (bucket's custom domain). */
export function publicUrl(key: string): string {
  return `${requireEnv("R2_PUBLIC_URL").replace(/\/+$/, "")}/${key}`;
}

/** Hard-delete an object (retention sweep). Missing keys are ignored. */
export async function deleteObject(key: string): Promise<void> {
  await client().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
}
