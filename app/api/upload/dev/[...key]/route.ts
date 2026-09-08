import { NextResponse, type NextRequest } from "next/server";

import { usingDevStore, DEV_STORE_PREFIX, writeDevStoreObject } from "@/lib/uploads/store";

/**
 * Local-dev-only stand-in for an R2 presigned PUT. `presignPut()` in
 * lib/uploads/store.ts only ever hands the browser a URL under this route when
 * R2 env vars are absent (`usingDevStore()`), so this is unreachable — and
 * refuses outright — whenever real storage is configured.
 */
export async function PUT(req: NextRequest, ctx: { params: Promise<{ key: string[] }> }) {
  if (!usingDevStore()) {
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
