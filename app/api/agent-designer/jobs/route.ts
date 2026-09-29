import { NextResponse, type NextRequest } from "next/server";

import { listPendingJobs } from "@/lib/agent/ai-designer";
import { rejectUnlessAgent } from "@/lib/agent/ai-jobs-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Pending AI designer jobs (new and revision). See docs/agent-designer.md. */
export async function GET(req: NextRequest) {
  const denied = rejectUnlessAgent(req);
  if (denied) return denied;
  const jobs = await listPendingJobs();
  return NextResponse.json({ jobs });
}
