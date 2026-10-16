import { NextResponse, type NextRequest } from "next/server";

import { rejectUnlessAgent } from "@/lib/agent/ai-jobs-http";
import { listQcOverdue } from "@/lib/agent/qc-overdue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Portraits waiting on an owner's QC (awaiting_qc on /approve, or an AI
 * portrait held for the owner on /day) past the business's ownerQcSlaHours,
 * oldest first. ?all=1 lists every one waiting. Each item says when the wait
 * began, whether the URGENT and the backup hand-over went, who the owner and
 * backup approver are, and the link. Read only: the agent tick sends the
 * messages (lib/agent/qc-overdue.ts). Ami Multani #CPS10282 and Audrea Sanchez
 * 4196536586 waited 61 h and 64 h unseen (clean slating audit, 2026-10-16).
 */
export async function GET(req: NextRequest) {
  const denied = rejectUnlessAgent(req);
  if (denied) return denied;
  const sp = req.nextUrl.searchParams;
  const all = sp.get("all") === "1" || sp.get("all") === "true";
  const businessId = sp.get("businessId");
  if (businessId && !/^[0-9a-f-]{36}$/i.test(businessId)) {
    return NextResponse.json({ error: "businessId must be a business uuid" }, { status: 400 });
  }
  const items = await listQcOverdue({ all, businessIds: businessId ? [businessId] : undefined });
  return NextResponse.json({ now: new Date().toISOString(), count: items.length, items });
}
