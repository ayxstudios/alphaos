import { NextResponse, type NextRequest } from "next/server";

import { rejectUnlessAgent } from "@/lib/agent/ai-jobs-http";
import { parseFixBody } from "@/lib/qc/auto-qc-fix";
import { saveFix } from "@/lib/qc/auto-qc-fix-jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Store one fix answer (a ready fix image, or "no clean fix possible"). Never moves the order. See docs/AUTO_QC.md. */
export async function POST(req: NextRequest) {
  const denied = rejectUnlessAgent(req);
  if (denied) return denied;
  const parsed = parseFixBody(await req.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const saved = await saveFix(parsed.body);
  if (!saved.ok) return NextResponse.json({ error: saved.error }, { status: saved.status });
  return NextResponse.json({ ok: true, id: saved.id });
}
