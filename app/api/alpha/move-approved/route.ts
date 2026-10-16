import { NextResponse, type NextRequest } from "next/server";

import { isAlphaCaller } from "@/lib/alpha/auth";
import { moveApproved } from "@/lib/orders/move-approved";

export const runtime = "nodejs";

const STATUS: Record<string, number> = { usage: 400, not_found: 404 };

/**
 * POST /api/alpha/move-approved  {order, to, approved?, apply?, reason?}
 * The agent carries out an owner's yes given in chat to move an order to
 * another designer. A revision or failed QC stays with its designer unless an
 * owner says yes (Yousif 2026-10-16, lib/orders/rework.ts): `approved` is who
 * said it and their words, kept on the order's timeline. Done as the Alpha VA
 * login, so the order page shows who carried it out; without `apply` it only
 * says what would happen. Both designers are told the usual way.
 */
export async function POST(req: NextRequest) {
  if (!isAlphaCaller(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const text = (k: string) => (typeof body?.[k] === "string" ? (body[k] as string) : null);
  const res = await moveApproved({
    order: text("order") ?? "",
    to: text("to") ?? "",
    approved: text("approved"),
    apply: body?.apply === true,
    by: "Alpha VA",
    reason: text("reason") ?? undefined,
  });
  return NextResponse.json(res, { status: res.ok ? 200 : (STATUS[res.code] ?? 409) });
}
