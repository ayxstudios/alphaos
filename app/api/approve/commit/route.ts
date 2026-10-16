import { NextResponse, type NextRequest } from "next/server";

import { auth } from "@/lib/auth";
import { ownerApproveCore, type ApproveActionResult } from "@/lib/qc/owner-approve";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The Approve flush (2026-10-14): when the owner closes or leaves /approve
 * inside the Stop window, the page posts every pending approval here with
 * keepalive so none is lost. Same staff check and the same core as the
 * ownerApprove server action; a repeat answers "stale" and sends nothing.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { orderId?: unknown; fixIds?: unknown; overrideReason?: unknown } | null;
  const orderId = typeof body?.orderId === "string" ? body.orderId : "";
  // "Send AI fix" (2026-10-14): the fix samples the owner chose, applied before the send.
  const fixIds = Array.isArray(body?.fixIds) ? body.fixIds.filter((f): f is string => typeof f === "string").slice(0, 12) : [];
  if (!/^[0-9a-f-]{36}$/i.test(orderId)) {
    return NextResponse.json({ ok: false, code: "bad_request", message: "Missing order." } satisfies ApproveActionResult, { status: 400 });
  }
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ ok: false, code: "auth", message: "Please sign in again." } satisfies ApproveActionResult, { status: 401 });
  }
  const role = session.user.role;
  if (role !== "admin" && role !== "va") {
    return NextResponse.json({ ok: false, code: "forbidden", message: "Only staff can approve artwork." } satisfies ApproveActionResult, { status: 403 });
  }
  const name = (session.user.name || session.user.email || "Staff").trim();
  const res = await ownerApproveCore({ id: session.user.id, role }, name.length >= 2 ? name : "Staff", orderId, { fixIds, overrideReason: typeof body?.overrideReason === "string" ? body.overrideReason : undefined });
  return NextResponse.json(res);
}
