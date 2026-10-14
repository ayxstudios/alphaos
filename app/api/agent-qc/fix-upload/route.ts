import { NextResponse, type NextRequest } from "next/server";

import { rejectUnlessAgent } from "@/lib/agent/ai-jobs-http";
import { createFixUpload } from "@/lib/qc/auto-qc-fix-jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A signed PUT for one fix image (full print size, straight to the private bucket). Body: { orderId, contentType }. */
export async function POST(req: NextRequest) {
  const denied = rejectUnlessAgent(req);
  if (denied) return denied;
  const body = (await req.json().catch(() => null)) as { orderId?: unknown; contentType?: unknown } | null;
  const orderId = typeof body?.orderId === "string" ? body.orderId : "";
  if (!orderId) return NextResponse.json({ error: "orderId required" }, { status: 400 });
  const res = await createFixUpload(orderId, typeof body?.contentType === "string" ? body.contentType : "image/jpeg");
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status });
  return NextResponse.json({ key: res.key, uploadUrl: res.uploadUrl });
}
