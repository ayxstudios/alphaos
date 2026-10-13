import { NextResponse, type NextRequest } from "next/server";

import { rejectUnlessAgent } from "@/lib/agent/ai-jobs-http";
import { listAutoQcJobs } from "@/lib/qc/auto-qc-jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Orders waiting for QC whose newest artwork has no Auto QC yet. See docs/AUTO_QC.md. */
export async function GET(req: NextRequest) {
  const denied = rejectUnlessAgent(req);
  if (denied) return denied;
  const sp = req.nextUrl.searchParams;
  const limit = Math.min(Math.max(Number(sp.get("limit")) || 10, 1), 25);
  const items = await listAutoQcJobs({ limit, orderNumber: sp.get("order") });
  return NextResponse.json({ items });
}
