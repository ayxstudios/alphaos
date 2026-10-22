import { NextResponse, type NextRequest } from "next/server";

import { auth } from "@/lib/auth";
import type { ApproveActionResult } from "@/lib/qc/owner-approve";
import { ownerRejectCore } from "@/lib/qc/owner-reject";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const strings = (v: unknown, max: number): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, max) : [];

/**
 * Reject on /approve (2026-10-22): the same staff check and core as the
 * ownerReject server action, as a plain route so the screen keeps the next
 * order it preloaded (lib/qc/owner-reject.ts).
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const orderId = typeof body?.orderId === "string" ? body.orderId : "";
  if (!/^[0-9a-f-]{36}$/i.test(orderId)) {
    return NextResponse.json({ ok: false, code: "bad_request", message: "Missing order." } satisfies ApproveActionResult, { status: 400 });
  }
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ ok: false, code: "auth", message: "Please sign in again." } satisfies ApproveActionResult, { status: 401 });
  }
  const role = session.user.role;
  if (role !== "admin" && role !== "va") {
    return NextResponse.json({ ok: false, code: "forbidden", message: "Only staff can send work back." } satisfies ApproveActionResult, { status: 403 });
  }
  const name = (session.user.name || session.user.email || "Staff").trim();
  const res = await ownerRejectCore({ id: session.user.id, role }, name.length >= 2 ? name : "Staff", {
    orderId,
    note: typeof body?.note === "string" ? body.note : "",
    failedKeys: Array.isArray(body?.failedKeys) ? body.failedKeys.filter((k): k is number => Number.isInteger(k)).slice(0, 50) : [],
    attachmentAssetIds: strings(body?.attachmentAssetIds, 20),
    attachFixIds: strings(body?.attachFixIds, 12),
  });
  return NextResponse.json(res);
}
