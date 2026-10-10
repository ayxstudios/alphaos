import { NextResponse, type NextRequest } from "next/server";
import { and, eq, sql } from "drizzle-orm";

import { withSystemContext } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { approveOwnerReview } from "@/lib/agent/ai-designer";
import { sendOwnerReviewBackToAi } from "@/lib/agent/owner-review";
import { rejectUnlessAgent } from "@/lib/agent/ai-jobs-http";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * The owner's decision on a held AI portrait, relayed by the agent from the
 * owner's own WhatsApp reply (Yousif 2026-10-10: "send me proofs of the before
 * and after before sending to the customer for me to approve"). Same effect as
 * the Day page buttons, acted as that owner: `approve` sends the held proof
 * email, `fix` sends the portrait back to the AI with the reason.
 * Body: { decision: "approve" | "fix", ownerEmail: string, reason?: string }
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const denied = rejectUnlessAgent(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const decision = body?.decision;
  const ownerEmail = typeof body?.ownerEmail === "string" ? body.ownerEmail.trim().toLowerCase() : "";
  if ((decision !== "approve" && decision !== "fix") || !ownerEmail) {
    return NextResponse.json({ error: "bad_request", message: "Send decision (approve|fix) and ownerEmail." }, { status: 400 });
  }
  const [owner] = await withSystemContext((tx) =>
    tx
      .select({ id: users.id })
      .from(users)
      .where(and(sql`lower(${users.email}) = ${ownerEmail}`, eq(users.role, "admin"), eq(users.active, true)))
      .limit(1),
  );
  if (!owner) return NextResponse.json({ error: "not_owner", message: "No active owner with that email." }, { status: 403 });

  if (decision === "approve") {
    const res = await approveOwnerReview(id, owner.id);
    return res.ok
      ? NextResponse.json({ ok: true, decision, messageId: res.messageId })
      : NextResponse.json({ error: res.code, message: res.message }, { status: res.code === "not_waiting" ? 409 : 422 });
  }
  const reason = typeof body?.reason === "string" ? body.reason.trim().slice(0, 1000) : "";
  if (!reason) return NextResponse.json({ error: "bad_request", message: "Say what needs fixing." }, { status: 400 });
  const res = await sendOwnerReviewBackToAi({ id: owner.id, role: "admin" }, id, reason);
  return res.ok
    ? NextResponse.json({ ok: true, decision })
    : NextResponse.json({ error: "not_waiting", message: res.message }, { status: 409 });
}
