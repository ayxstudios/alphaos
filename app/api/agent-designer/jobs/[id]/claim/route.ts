import { NextResponse, type NextRequest } from "next/server";

import { claimJob } from "@/lib/agent/ai-designer";
import { jobError, rejectUnlessAgent } from "@/lib/agent/ai-jobs-http";

export const runtime = "nodejs";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const denied = rejectUnlessAgent(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  try {
    return NextResponse.json({ ok: true, job: await claimJob(id) });
  } catch (e) {
    return jobError(e);
  }
}
