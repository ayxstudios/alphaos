/**
 * Set the CORS rules on the R2 bucket so a customer's browser can PUT straight
 * to a presigned upload URL from the app's origin (the /upload/[token] page).
 *
 * R2 only honours CORS rules stored on the bucket; a bucket that only lists
 * localhost origins makes every browser upload from the deployed app fail its
 * preflight, and the customer sees "Upload failed. Check your connection".
 *
 * Origins: NEXT_PUBLIC_APP_URL / AUTH_URL from the env, the local dev ports,
 * plus any extra origins passed as arguments (e.g. a preview deployment).
 *
 *   npx tsx scripts/r2-cors.ts https://alphaos-kappa.vercel.app
 */
import "./load-env";
import { S3Client, GetBucketCorsCommand, PutBucketCorsCommand } from "@aws-sdk/client-s3";

import { isR2Configured } from "../lib/storage/r2";

const LOCAL_ORIGINS = ["http://localhost:3000", "http://localhost:3111", "http://localhost:3122"];

function origin(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

async function main() {
  if (!isR2Configured()) {
    console.error("R2 is not configured (R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY).");
    process.exit(1);
  }
  const origins = [
    ...new Set(
      [process.env.NEXT_PUBLIC_APP_URL, process.env.AUTH_URL, ...process.argv.slice(2), ...LOCAL_ORIGINS]
        .map(origin)
        .filter((o): o is string => !!o),
    ),
  ];

  const s3 = new S3Client({
    region: "auto",
    endpoint: process.env.R2_ENDPOINT,
    forcePathStyle: true,
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID!, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY! },
  });
  const Bucket = process.env.R2_BUCKET!;

  await s3.send(
    new PutBucketCorsCommand({
      Bucket,
      CORSConfiguration: {
        CORSRules: [
          {
            AllowedOrigins: origins,
            AllowedMethods: ["GET", "PUT", "HEAD"],
            AllowedHeaders: ["*"],
            ExposeHeaders: ["ETag"],
            MaxAgeSeconds: 3600,
          },
        ],
      },
    }),
  );

  const { CORSRules } = await s3.send(new GetBucketCorsCommand({ Bucket }));
  console.log(`R2 CORS on bucket "${Bucket}" now allows:`);
  for (const o of CORSRules?.[0]?.AllowedOrigins ?? []) console.log(`  ${o}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
