import { NextResponse, type NextRequest } from "next/server";

import { isAlphaCaller } from "@/lib/alpha/auth";
import { agentRevision } from "@/lib/orders/agent-revision";

export const runtime = "nodejs";

const STATUS: Record<string, number> = { usage: 400, not_found: 404 };

/**
 * POST /api/alpha/revision  {order, reason, by?, apply?}
 * The agent lands a change request the buyer made outside the proof page (an
 * Etsy chat): the same road as her own "Request changes" on the proof out for
 * approval, so the order goes back to the SAME designer with her words on the
 * card (lib/orders/agent-revision.ts). After approval or delivery it is a late
 * revision to the same designer, refused once a print is ordered (a reprint is
 * the owner's call); without `apply` it only says what would happen.
 */
export async function POST(req: NextRequest) {
  if (!isAlphaCaller(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const text = (k: string) => (typeof body?.[k] === "string" ? (body[k] as string) : null);
  const res = await agentRevision({
    order: text("order") ?? "",
    reason: text("reason") ?? "",
    by: text("by"),
    apply: body?.apply === true,
  });
  return NextResponse.json(res, { status: res.ok ? 200 : (STATUS[res.code] ?? 409) });
}
