import { NextResponse, type NextRequest } from "next/server";

import { deliverJob } from "@/lib/agent/ai-designer";
import { jobError, rejectUnlessAgent } from "@/lib/agent/ai-jobs-http";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const denied = rejectUnlessAgent(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return NextResponse.json({ error: "bad_json", message: "Send a JSON body." }, { status: 400 });
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  try {
    const res = await deliverJob(id, {
      url: str(body.url),
      base64: str(body.base64),
      contentType: str(body.contentType),
      filename: str(body.filename),
      selfCheck: str(body.selfCheck),
    });
    return NextResponse.json({ ok: true, orderStatus: res.status, assetId: res.assetId });
  } catch (e) {
    return jobError(e);
  }
}
