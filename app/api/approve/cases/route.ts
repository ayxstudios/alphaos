import { NextResponse, type NextRequest } from "next/server";

import { auth } from "@/lib/auth";
import { listCases, writeDecision, writeUndo, type CaseDecision, type CaseWrite } from "@/lib/cases/cards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * The Cases swiper's own road (2026-10-25: "when you click something it waits then goes to the next one"). The
 * screen shows the next case at once and records the swipe here in the background, so a tap never waits for the
 * agent's page in the US, and a plain route (unlike a server action) never holds up the page's other navigation.
 * GET = the live list for the screen's background refresh. POST {op:"decide", ...CaseDecision} | {op:"undo", id}.
 * Owners (admin) only. A recorded swipe waits the agent's 30 s undo window, then the agent carries it out.
 */
async function owner(): Promise<CaseWrite | null> {
  const session = await auth();
  if (!session?.user) return { ok: false, message: "Please sign in again." };
  if (session.user.role !== "admin") return { ok: false, message: "Only the owners can decide cases." };
  return null;
}

export async function GET() {
  const denied = await owner();
  if (denied) return NextResponse.json(denied, { status: 403 });
  const at = Date.now();
  const cards = await listCases();
  return NextResponse.json({ ok: cards !== null, cards: cards ?? [], at }, { headers: { "cache-control": "no-store" } });
}

export async function POST(req: NextRequest) {
  const denied = await owner();
  if (denied) return NextResponse.json(denied, { status: 403 });
  const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const id = typeof b?.id === "string" && b.id ? b.id : null;
  if (!b || !id) return NextResponse.json({ ok: false, message: "That case could not be found." } satisfies CaseWrite, { status: 400 });
  if (b.op === "undo") return NextResponse.json(await writeUndo(id));
  if (b.op !== "decide") return NextResponse.json({ ok: false, message: "Unknown step." } satisfies CaseWrite, { status: 400 });

  let d: CaseDecision;
  if (b.decision === "tick") {
    const off = Array.isArray(b.actionsOff) ? b.actionsOff.filter((n): n is number => Number.isInteger(n) && n >= 0 && n < 100).slice(0, 100) : [];
    d = { id, decision: "tick", replyEdit: typeof b.replyEdit === "string" ? b.replyEdit : "", actionsOff: off };
  } else if (b.decision === "own") {
    const text = typeof b.ownerText === "string" ? b.ownerText.trim() : "";
    if (!text) return NextResponse.json({ ok: false, message: "Write what to do first." } satisfies CaseWrite, { status: 400 });
    d = { id, decision: "own", ownerText: text };
  } else if (b.decision === "sorted") {
    d = { id, decision: "sorted" };
  } else {
    return NextResponse.json({ ok: false, message: "Unknown decision." } satisfies CaseWrite, { status: 400 });
  }
  return NextResponse.json(await writeDecision(d));
}
