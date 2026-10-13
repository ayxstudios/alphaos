import { NextResponse, type NextRequest } from "next/server";

import { rejectUnlessAgent } from "@/lib/agent/ai-jobs-http";
import { parseAutoQcBody } from "@/lib/qc/auto-qc";
import { saveAutoQc } from "@/lib/qc/auto-qc-jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Store one Auto QC answer. Informational only: never moves the order. See docs/AUTO_QC.md. */
export async function POST(req: NextRequest) {
  const denied = rejectUnlessAgent(req);
  if (denied) return denied;
  const parsed = parseAutoQcBody(await req.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const saved = await saveAutoQc(parsed.body);
  if (!saved.ok) return NextResponse.json({ error: saved.error }, { status: saved.status });
  return NextResponse.json({ ok: true, id: saved.id });
}
