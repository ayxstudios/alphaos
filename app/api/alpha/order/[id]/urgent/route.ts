import { NextResponse, type NextRequest } from "next/server";

import { isAlphaCaller } from "@/lib/alpha/auth";
import { withSystemContext } from "@/lib/db";
import { setOrderUrgent } from "@/lib/orders/urgent";

export const runtime = "nodejs";

/**
 * POST /api/alpha/order/:id/urgent  { urgent?: boolean (default true), reason?: string }
 * The agent pulls a chased legacy/stalled order to the front (Yousif
 * 2026-10-12: "Otherwise send it to the alphaOS as urgent"). Same rules as the
 * order page button: deadline kept, or set 24 h out when there is none;
 * logged with actor null (the agent).
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!isAlphaCaller(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown> | null;
  const urgent = body?.urgent !== false;
  const reason = typeof body?.reason === "string" ? body.reason : null;
  const res = await withSystemContext((tx) => setOrderUrgent(tx, { orderId: id, urgent, reason, actorId: null, via: "agent" }));
  if (!res.ok) return NextResponse.json({ error: "not_found", message: res.message }, { status: 404 });
  return NextResponse.json({
    ok: true,
    urgent,
    changed: res.changed,
    urgentAt: res.urgentAt?.toISOString() ?? null,
    dueAt: res.dueAt?.toISOString() ?? null,
  });
}
