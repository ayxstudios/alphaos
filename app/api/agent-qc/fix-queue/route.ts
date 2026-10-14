import { NextResponse, type NextRequest } from "next/server";

import { rejectUnlessAgent } from "@/lib/agent/ai-jobs-http";
import { listFixJobs } from "@/lib/qc/auto-qc-fix-jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Orders whose current Auto QC found problems and that have no fix attempt yet. See docs/AUTO_QC.md "Fix samples". */
export async function GET(req: NextRequest) {
  const denied = rejectUnlessAgent(req);
  if (denied) return denied;
  const sp = req.nextUrl.searchParams;
  const limit = Math.min(Math.max(Number(sp.get("limit")) || 4, 1), 10);
  const items = await listFixJobs({ limit, orderNumber: sp.get("order") });
  return NextResponse.json({ items });
}
