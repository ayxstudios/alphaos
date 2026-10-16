// The agent lands a change request the buyer made outside the proof page, in an
// Etsy chat the inbox never reads (Yousif 2026-10-17: "Most of these "Needs
// you" should be done by you"; Katie Hutchinson, Perfetta 4197441022, asked in
// Etsy chat for the pumpkin and the flowers back as in the first version, and it
// went to an owner because nothing the agent could call would queue it). The
// same road as her own "Request changes" on the proof page (requestRevision in
// lib/proofs/decide.ts): the newest proof out for approval takes the decision,
// the order goes back to in_design with the SAME designer (a revision never
// moves, lib/orders/rework.ts) and her words reach the designer's card. Only a
// proof out for approval: a change after approval or delivery goes through the
// order page. Nothing changes without `apply`.
import { and, desc, eq, or, sql } from "drizzle-orm";

import { withSystemContext } from "@/lib/db";
import { assignments, businesses, orders, proofs, users } from "@/lib/db/schema";
import { requestRevision } from "@/lib/proofs/decide";

/** activity_log metadata.via of a revision the agent landed from her chat (lib/orders/revision-history.ts counts it as hers). */
export const AGENT_REVISION_VIA = "agent_chat";

export type AgentRevisionInput = {
  /** Order number as staff see it (PC32132, an Etsy receipt), the platform id, or the AlphaOS id. */
  order: string;
  /** What she asked for, in full: it is what the designer reads. */
  reason: string;
  /** Where she said it and who carried it out, e.g. "Etsy chat 17 Oct, Alpha VA". Kept on the timeline. */
  by?: string | null;
  apply?: boolean;
};

export type AgentRevisionResult =
  | {
      ok: true;
      applied: boolean;
      order: string;
      orderId: string;
      business: string;
      designer: string | null;
      /** The revision number this change becomes. */
      revision: number;
      reason: string;
    }
  | { ok: false; code: string; message: string };

export async function agentRevision(input: AgentRevisionInput): Promise<AgentRevisionResult> {
  const key = String(input.order ?? "").trim().replace(/^#/, "");
  const reason = String(input.reason ?? "").replace(/\r\n?/g, "\n").trim();
  if (!key || !reason) return { ok: false, code: "usage", message: "Say which order and what she wants changed." };

  const plan = await withSystemContext(async (tx) => {
    const found = await tx
      .select({
        id: orders.id,
        business: businesses.name,
        number: sql<string>`coalesce(${orders.platformOrderName}, ${orders.platformOrderId})`,
        status: orders.status,
        archived: sql<boolean>`${orders.archivedAt} is not null`,
        revisionCount: orders.revisionCount,
      })
      .from(orders)
      .innerJoin(businesses, eq(businesses.id, orders.businessId))
      .where(
        or(
          sql`${orders.id}::text = ${key}`,
          eq(orders.platformOrderId, key),
          sql`lower(${orders.platformOrderName}) = lower(${key})`,
        ),
      )
      .limit(5);
    if (!found.length) return { ok: false as const, code: "not_found", message: `No order ${key}.` };
    if (found.length > 1) {
      return {
        ok: false as const,
        code: "ambiguous",
        message: `${found.length} orders match ${key} (${found.map((f) => f.business).join(", ")}): use the AlphaOS id.`,
      };
    }
    const o = found[0];
    if (o.archived) {
      return { ok: false as const, code: "archived", message: `Order ${o.number} is archived: reopen it on the order page first.` };
    }
    if (o.status !== "awaiting_approval") {
      return {
        ok: false as const,
        code: "not_awaiting_approval",
        message: `Order ${o.number} is ${String(o.status).replace(/_/g, " ")}, not out for approval: a change now goes through the order page.`,
      };
    }
    const [p] = await tx
      .select({ token: proofs.token, decision: proofs.decision })
      .from(proofs)
      .where(eq(proofs.orderId, o.id))
      .orderBy(desc(proofs.createdAt))
      .limit(1);
    if (!p) return { ok: false as const, code: "no_proof", message: `Order ${o.number} has no proof on record.` };
    if (p.decision) {
      return { ok: false as const, code: "already_decided", message: `The newest proof on ${o.number} already has a decision (${p.decision}).` };
    }
    const [d] = await tx
      .select({ name: users.name, email: users.email })
      .from(assignments)
      .innerJoin(users, eq(users.id, assignments.designerId))
      .where(and(eq(assignments.orderId, o.id), eq(assignments.active, true)))
      .limit(1);
    return { ok: true as const, o, token: p.token, designer: d ? (d.name ?? d.email) : null };
  });
  if (!plan.ok) return plan;

  const base = {
    order: plan.o.number,
    orderId: plan.o.id,
    business: plan.o.business,
    designer: plan.designer,
    revision: plan.o.revisionCount + 1,
    reason,
  };
  if (!input.apply) return { ok: true, applied: false, ...base };

  const res = await requestRevision(
    plan.token,
    { issueKeys: [], note: reason, annotations: [] },
    { via: AGENT_REVISION_VIA, by: input.by?.trim() || "agent" },
  );
  if (!res.ok) return { ok: false, code: res.code, message: res.message };
  return { ok: true, applied: true, ...base };
}
