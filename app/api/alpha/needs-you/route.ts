import { NextResponse, type NextRequest } from "next/server";

import { isAlphaCaller } from "@/lib/alpha/auth";
import { isOwnerTag } from "@/lib/agent/needs-you";
import { listNeedsYou, noteByAgent, raiseToOwner, resolveByAgent, takeForAgent } from "@/lib/agent/needs-you-desk";

export const runtime = "nodejs";

/**
 * NEEDS YOU (Yousif 2026-10-17: "Most of these Needs you should be done by you
 * ... Upset customers should be sent to me"). The agent's side of the owner
 * message (lib/agent/needs-you.ts): only an upset buyer, money back or a legal
 * threat reaches an owner; the agent works the rest.
 *
 * GET  [?business=<id>]                       every open row with its road (owner, agent, close). Read-only.
 * POST {op:"take", limit?}                     the agent's due rows, stamped as taken.
 * POST {op:"resolve", id, note}                done: resolved with the note.
 * POST {op:"note", id, note}                   where it got to; the owner sees it if the agent gives up.
 * POST {op:"owner", id, kinds:[...], note}     hand it to an owner: upset | refund | legal | revision.
 */
export async function GET(req: NextRequest) {
  if (!isAlphaCaller(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const business = req.nextUrl.searchParams.get("business");
  const items = await listNeedsYou({ businessIds: business ? [business] : undefined });
  const byRoad: Record<string, number> = {};
  for (const i of items) byRoad[i.road] = (byRoad[i.road] ?? 0) + 1;
  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    total: items.length,
    byRoad,
    takeable: items.filter((i) => i.takeable).length,
    items,
  });
}

const text = (v: unknown, max = 2000) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

export async function POST(req: NextRequest) {
  if (!isAlphaCaller(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const op = body?.op;
  if (op === "take") {
    const limit = typeof body?.limit === "number" ? body.limit : undefined;
    const items = await takeForAgent({ limit });
    return NextResponse.json({ ok: true, taken: items.length, items });
  }
  const id = text(body?.id, 64);
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ ok: false, error: "id (the row's uuid) is required" }, { status: 400 });
  const note = text(body?.note);
  if (!note) return NextResponse.json({ ok: false, error: "note is required: what was done, or what the owner should decide" }, { status: 400 });
  let r;
  if (op === "resolve") r = await resolveByAgent(id, note);
  else if (op === "note") r = await noteByAgent(id, note);
  else if (op === "owner") {
    const kinds = Array.isArray(body?.kinds) ? body.kinds.filter(isOwnerTag) : [];
    if (!kinds.length) return NextResponse.json({ ok: false, error: "kinds: one or more of upset, refund, legal, revision" }, { status: 400 });
    r = await raiseToOwner(id, kinds, note);
  } else return NextResponse.json({ ok: false, error: "op: take | resolve | note | owner" }, { status: 400 });
  return NextResponse.json(r, { status: r.ok ? 200 : 404 });
}
