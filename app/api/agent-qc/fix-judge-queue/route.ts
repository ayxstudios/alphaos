import { NextResponse, type NextRequest } from "next/server";

import { rejectUnlessAgent } from "@/lib/agent/ai-jobs-http";
import { listFixJudgeJobs } from "@/lib/qc/auto-qc-fix-jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Ready AI fixes the Auto QC judge has not looked at yet (Yousif 2026-10-14: the Auto QC judges the AI fix too). See docs/AUTO_QC.md "Fix samples". */
export async function GET(req: NextRequest) {
  const denied = rejectUnlessAgent(req);
  if (denied) return denied;
  const sp = req.nextUrl.searchParams;
  const limit = Math.min(Math.max(Number(sp.get("limit")) || 4, 1), 10);
  const items = await listFixJudgeJobs({ limit, orderNumber: sp.get("order") });
  return NextResponse.json({ items });
}
