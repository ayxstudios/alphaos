import { NextResponse, type NextRequest } from "next/server";

import { rejectUnlessAgent } from "@/lib/agent/ai-jobs-http";
import { parseFixQcBody } from "@/lib/qc/auto-qc-fix";
import { saveFixQc } from "@/lib/qc/auto-qc-fix-jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Store the Auto QC verdict on one AI fix. Notes only: never moves the order or the fix. See docs/AUTO_QC.md "Fix samples". */
export async function POST(req: NextRequest) {
  const denied = rejectUnlessAgent(req);
  if (denied) return denied;
  const parsed = parseFixQcBody(await req.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const saved = await saveFixQc(parsed.body);
  if (!saved.ok) return NextResponse.json({ error: saved.error }, { status: saved.status });
  return NextResponse.json({ ok: true, id: saved.id });
}
