import { NextResponse, type NextRequest } from "next/server";

import { failJob } from "@/lib/agent/ai-designer";
import { jobError, rejectUnlessAgent } from "@/lib/agent/ai-jobs-http";

export const runtime = "nodejs";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const denied = rejectUnlessAgent(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => null)) as { reason?: unknown } | null;
  try {
    const res = await failJob(id, typeof body?.reason === "string" ? body.reason : null);
    // handedTo: the person the order went to straight away (null = it stayed, the owner hears).
    return NextResponse.json({ ok: true, exceptionId: res.exceptionId, handedTo: res.handedTo });
  } catch (e) {
    return jobError(e);
  }
}
