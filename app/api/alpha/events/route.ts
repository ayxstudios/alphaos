import { NextResponse, type NextRequest } from "next/server";
import { and, asc, eq, inArray } from "drizzle-orm";

import { isAlphaCaller } from "@/lib/alpha/auth";
import { withSystemContext } from "@/lib/db";
import { alphaEvents, businesses, orders, users } from "@/lib/db/schema";

export const runtime = "nodejs";

/** GET /api/alpha/events?status=queued&limit=50  (the daemon's poll) */
export async function GET(req: NextRequest) {
  if (!isAlphaCaller(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const status = req.nextUrl.searchParams.get("status") || "queued";
  const limit = Math.min(200, Number(req.nextUrl.searchParams.get("limit") || 50));
  const rows = await withSystemContext(async (tx) => {
    return tx
      .select({
        id: alphaEvents.id,
        type: alphaEvents.type,
        text: alphaEvents.text,
        payload: alphaEvents.payload,
        status: alphaEvents.status,
        createdAt: alphaEvents.createdAt,
        businessId: alphaEvents.businessId,
        businessName: businesses.name,
        orderId: alphaEvents.orderId,
        orderNumber: orders.platformOrderName,
        toRole: alphaEvents.toRole,
        toUserId: alphaEvents.toUserId,
        toName: users.name,
        toEmail: users.email,
      })
      .from(alphaEvents)
      .leftJoin(businesses, eq(businesses.id, alphaEvents.businessId))
      .leftJoin(orders, eq(orders.id, alphaEvents.orderId))
      .leftJoin(users, eq(users.id, alphaEvents.toUserId))
      .where(eq(alphaEvents.status, status))
      .orderBy(asc(alphaEvents.createdAt))
      .limit(limit);
  });
  return NextResponse.json({ events: rows });
}

/** POST /api/alpha/events  { acks: [{ id, status: "delivered"|"failed", error? }] } */
export async function POST(req: NextRequest) {
  if (!isAlphaCaller(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { acks?: { id: string; status: string; error?: string }[] };
  const acks = (body.acks || []).filter((a) => a && a.id && ["delivered", "failed", "skipped"].includes(a.status));
  if (!acks.length) return NextResponse.json({ updated: 0 });
  const updated = await withSystemContext(async (tx) => {
    let n = 0;
    for (const a of acks) {
      const r = await tx
        .update(alphaEvents)
        .set({ status: a.status, error: a.error ?? null, deliveredAt: a.status === "delivered" ? new Date() : null })
        .where(and(eq(alphaEvents.id, a.id), inArray(alphaEvents.status, ["queued", "failed"])))
        .returning({ id: alphaEvents.id });
      n += r.length;
    }
    return n;
  });
  return NextResponse.json({ updated });
}
