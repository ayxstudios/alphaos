import { NextResponse, type NextRequest } from "next/server";

import { rejectUnlessAgent } from "@/lib/agent/ai-jobs-http";
import { usingDevStore, DEV_STORE_PREFIX, writeDevStoreObject, headStored, readStoredObject } from "@/lib/uploads/store";

/**
 * Local-dev-only stand-in for an R2 presigned PUT. `presignPut()` in
 * lib/uploads/store.ts only ever hands the browser a URL under this route when
 * R2 env vars are absent (`usingDevStore()`), so this is unreachable, and
 * refuses outright, whenever real storage is configured or the code runs on
 * a Vercel deployment.
 */
export async function PUT(req: NextRequest, ctx: { params: Promise<{ key: string[] }> }) {
  // Never on a deployed environment, whatever the storage env says: an
  // unauthenticated PUT that writes to the function's disk has no place on
  // Vercel (customer + security QA 2026-09-25). Vercel sets VERCEL=1 on every
  // deployment; local dev and CI never do.
  if (process.env.VERCEL || !usingDevStore()) {
    return NextResponse.json({ error: "Dev upload store is disabled (R2 is configured)" }, { status: 404 });
  }
  const { key } = await ctx.params;
  const rel = key.map(decodeURIComponent).join("/");
  if (!rel || rel.includes("..")) {
    return NextResponse.json({ error: "Invalid key" }, { status: 400 });
  }
  const contentType = req.headers.get("content-type") || "application/octet-stream";
  const buf = Buffer.from(await req.arrayBuffer());
  if (buf.length === 0) {
    return NextResponse.json({ error: "Empty body" }, { status: 400 });
  }
  await writeDevStoreObject(`${DEV_STORE_PREFIX}${rel}`, contentType, buf);
  return new NextResponse(null, { status: 200 });
}

/**
 * Dev-store read for the external agent runner: buyer reference photos live
 * here when R2 is absent (demo/dev). Same gate as the jobs API (AGENT_JOBS_TOKEN
 * bearer), so uploaded photos are never world-readable.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ key: string[] }> }) {
  if (!usingDevStore()) {
    return NextResponse.json({ error: "Dev upload store is disabled (R2 is configured)" }, { status: 404 });
  }
  const denied = rejectUnlessAgent(req);
  if (denied) return denied;
  const { key } = await ctx.params;
  const rel = key.map(decodeURIComponent).join("/");
  if (!rel || rel.includes("..")) {
    return NextResponse.json({ error: "Invalid key" }, { status: 400 });
  }
  const devKey = `${DEV_STORE_PREFIX}${rel}`;
  try {
    const [head, bytes] = await Promise.all([headStored(devKey), readStoredObject(devKey)]);
    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "content-type": head.contentType ?? "application/octet-stream",
        "content-length": String(bytes.length),
        "cache-control": "private, no-store",
      },
    });
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}
