import { NextResponse, type NextRequest } from "next/server";

import { isAlphaCaller } from "@/lib/alpha/auth";
import { reopenUndrawn } from "@/lib/orders/reopen-undrawn";

export const runtime = "nodejs";

/** POST /api/alpha/reopen-undrawn {order, why, apply?}: an import-closed order nobody ever drew goes back to ready_to_assign. */
export async function POST(req: NextRequest) {
  if (!isAlphaCaller(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const t = (k: string) => (typeof body?.[k] === "string" ? (body[k] as string) : "");
  const res = await reopenUndrawn({ order: t("order"), why: t("why"), apply: body?.apply === true });
  return NextResponse.json(res, { status: res.ok ? 200 : res.code === "not_found" ? 404 : res.code === "usage" ? 400 : 409 });
}
