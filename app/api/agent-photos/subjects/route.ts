// The agent's photo check (lib/photos/subjects.ts): GET hands out orders whose
// photos were never checked or changed since, POST stores what the check found
// (a named slot for each pet or person bought and how clear its face is).
//
//   GET  ?order=<id>[&md5=1]           one order's job (md5 = the stored files' md5, for the photo bridge)
//   GET  ?business=<id,id>&limit=<n>   the queue, most urgent first
//   POST {orderId, photoSig, model, subjects, extra}

import { NextResponse, type NextRequest } from "next/server";

import { rejectUnlessAgent } from "@/lib/agent/ai-jobs-http";
import { withSystemContext } from "@/lib/db";
import { buildSubjectJob, listSubjectQueue, saveSubjectCheck } from "@/lib/photos/subjects";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const ID = /^[A-Za-z0-9_-]{6,64}$/;

export async function GET(req: NextRequest) {
  const denied = rejectUnlessAgent(req);
  if (denied) return denied;
  const sp = req.nextUrl.searchParams;
  const one = sp.get("order");
  if (one) {
    if (!ID.test(one)) return NextResponse.json({ error: "bad order id" }, { status: 400 });
    const job = await buildSubjectJob(one, { md5: sp.get("md5") === "1" });
    return job ? NextResponse.json({ job }) : NextResponse.json({ error: "order not found" }, { status: 404 });
  }
  const businessIds = (sp.get("business") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => ID.test(s));
  const limit = Math.max(1, Math.min(20, Number(sp.get("limit")) || 4));
  const ids = await listSubjectQueue({ businessIds: businessIds.length ? businessIds : null, limit });
  const items = [];
  for (const id of ids) {
    const job = await buildSubjectJob(id);
    if (job) items.push(job);
  }
  return NextResponse.json({ items });
}

export async function POST(req: NextRequest) {
  const denied = rejectUnlessAgent(req);
  if (denied) return denied;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const orderId = typeof body?.orderId === "string" ? body.orderId : "";
  if (!body || !ID.test(orderId)) return NextResponse.json({ error: "orderId required" }, { status: 400 });
  const res = await withSystemContext((tx) =>
    saveSubjectCheck(tx, { orderId, photoSig: body.photoSig, model: body.model, subjects: body.subjects, extra: body.extra }),
  );
  if (!res.ok) return NextResponse.json({ error: res.error, photoSig: res.photoSig }, { status: res.status });
  return NextResponse.json(res);
}
