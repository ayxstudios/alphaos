// The agent lands a change request the buyer made outside the proof page, in an
// Etsy chat the inbox never reads (Yousif 2026-10-17: "Most of these "Needs
// you" should be done by you"; Katie Hutchinson, Perfetta 4197441022, asked in
// Etsy chat for the pumpkin and the flowers back as in the first version, and it
// went to an owner because nothing the agent could call would queue it). The
// same road as her own "Request changes" on the proof page (requestRevision in
// lib/proofs/decide.ts): the newest proof out for approval takes the decision,
// the order goes back to in_design with the SAME designer (a revision never
// moves, lib/orders/rework.ts) and her words reach the designer's card. A
// change she asks for after approval or delivery is the order page's late
// customer revision (approved/delivered/complete -> in_design), same designer,
// her words on the card, as long as nothing is printed: once a print job exists,
// the order is printing or shipped, or a physical piece has reached her, the
// change is a reprint at our cost, which is the owner's call. Nothing changes
// without `apply`.
import { and, desc, eq, or, sql } from "drizzle-orm";

import { withSystemContext } from "@/lib/db";
import { assignments, businesses, orderItems, orders, printJobs, proofs, users } from "@/lib/db/schema";
import { OrderTransitionError, transitionAsSystem } from "@/lib/orders/transitions";
import { requestRevision } from "@/lib/proofs/decide";

/** activity_log metadata.via of a revision the agent landed from her chat (lib/orders/revision-history.ts counts it as hers). */
export const AGENT_REVISION_VIA = "agent_chat";

/** Drawn and approved or with her already: her change is a late revision, same designer (owner, 2026-10-17). */
const LATE_STATUSES = new Set(["approved", "delivered", "complete"]);
/** Still with the designer or QC: nothing of this round is out to her yet. */
const BEFORE_PROOF = new Set(["awaiting_photos", "ready_to_assign", "in_design", "awaiting_qc"]);

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
      /** Where the order was: awaiting_approval (her proof), or approved/delivered/complete (a late revision). */
      from: string;
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
    const words = String(o.status).replace(/_/g, " ");
    if (o.status === "printing" || o.status === "shipped") {
      return {
        ok: false as const,
        code: "print_ordered",
        message: `Order ${o.number} is ${words}: a change now means a reprint at our cost, the owner's call.`,
      };
    }
    if (o.status !== "awaiting_approval" && !LATE_STATUSES.has(o.status)) {
      return {
        ok: false as const,
        code: "not_awaiting_approval",
        message: BEFORE_PROOF.has(o.status)
          ? `Order ${o.number} is ${words}: nothing of this round is out to her yet, so her words go on the order as a note for the designer.`
          : `Order ${o.number} is ${words}: a change goes through the order page.`,
      };
    }
    const late = o.status !== "awaiting_approval";
    if (late) {
      const [pj] = await tx.select({ id: printJobs.id }).from(printJobs).where(eq(printJobs.orderId, o.id)).limit(1);
      if (pj) {
        return {
          ok: false as const,
          code: "print_ordered",
          message: `A print is already ordered for ${o.number}: a change now means a reprint at our cost, the owner's call.`,
        };
      }
      if (o.status !== "approved") {
        const [physical] = await tx
          .select({ id: orderItems.id })
          .from(orderItems)
          .where(and(eq(orderItems.orderId, o.id), eq(orderItems.productType, "physical")))
          .limit(1);
        if (physical) {
          return {
            ok: false as const,
            code: "print_ordered",
            message: `Order ${o.number} has a physical piece that is already ${words}: a change now means a reprint at our cost, the owner's call.`,
          };
        }
      }
    }
    const [p] = await tx
      .select({ token: proofs.token, decision: proofs.decision })
      .from(proofs)
      .where(eq(proofs.orderId, o.id))
      .orderBy(desc(proofs.createdAt))
      .limit(1);
    if (!p && !late) return { ok: false as const, code: "no_proof", message: `Order ${o.number} has no proof on record.` };
    if (p?.decision && !late) {
      return { ok: false as const, code: "already_decided", message: `The newest proof on ${o.number} already has a decision (${p.decision}).` };
    }
    const [d] = await tx
      .select({ name: users.name, email: users.email })
      .from(assignments)
      .innerJoin(users, eq(users.id, assignments.designerId))
      .where(and(eq(assignments.orderId, o.id), eq(assignments.active, true)))
      .limit(1);
    return { ok: true as const, o, late, token: p?.token ?? null, designer: d ? (d.name ?? d.email) : null };
  });
  if (!plan.ok) return plan;

  const base = {
    order: plan.o.number,
    orderId: plan.o.id,
    business: plan.o.business,
    designer: plan.designer,
    revision: plan.o.revisionCount + 1,
    reason,
    from: String(plan.o.status),
  };
  if (!input.apply) return { ok: true, applied: false, ...base };

  const by = input.by?.trim() || "agent";
  if (plan.late || !plan.token) {
    try {
      await transitionAsSystem({
        orderId: plan.o.id,
        to: "in_design",
        expectedFrom: plan.o.status,
        metadata: { via: AGENT_REVISION_VIA, requestedBy: by, revisionReason: reason, orderNumber: plan.o.number },
      });
    } catch (e) {
      if (e instanceof OrderTransitionError) return { ok: false, code: e.code, message: e.message };
      throw e;
    }
    return { ok: true, applied: true, ...base };
  }
  const res = await requestRevision(
    plan.token,
    { issueKeys: [], note: reason, annotations: [] },
    { via: AGENT_REVISION_VIA, by },
  );
  if (!res.ok) return { ok: false, code: res.code, message: res.message };
  return { ok: true, applied: true, ...base };
}
