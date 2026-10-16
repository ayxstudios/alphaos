// Carry out an owner's yes to move a revision or failed QC to another designer
// (Yousif 2026-10-16: "From now on don't move revisions or failed QC to another
// designer unless I approve it. It can confuse designers and often they need
// the source file"). Every other path refuses that move (lib/orders/rework.ts,
// migration 0063). This is the road for a yes given outside the order page, in
// chat: the order page's own Reassign (reassignOrder: new assignment, the brief
// to the new designer) with the owner's words on the move, then both designers
// hear it the usual way (sendDesignerReassigned). Nothing changes without
// `apply`; a move that needs a yes is refused without `approved`.
import { and, eq, or, sql } from "drizzle-orm";

import { reassignOrder } from "@/lib/agent/ai-designer";
import { withSystemContext } from "@/lib/db";
import { assignments, businesses, designerBusinesses, designerProfiles, orders, users } from "@/lib/db/schema";
import { sendDesignerReassigned } from "@/lib/notifications/designer-events";

import { loadReworkHold, reworkAllows } from "./rework";

export type MoveApprovedInput = {
  /** Order number as staff see it (PC32132, an Etsy receipt), the platform id, or the AlphaOS id. */
  order: string;
  /** Designer name, any case, in the order's business. */
  to: string;
  /** Whose yes and their words, e.g. "Yousif in chat: give it to Slamet". */
  approved?: string | null;
  apply?: boolean;
  /** Who carries it out (a user name or email), e.g. the agent's "Alpha VA" login. */
  by?: string | null;
  /** What both designers are told. */
  reason?: string;
};

export type MoveApprovedResult =
  | {
      ok: true;
      applied: boolean;
      order: string;
      from: string | null;
      to: string;
      rework: boolean;
      needsYes: boolean;
      approvedBy: string | null;
      noticeSent: boolean;
    }
  | { ok: false; code: string; message: string };

const DEFAULT_REASON = "An owner asked for it to move.";

export async function moveApproved(input: MoveApprovedInput): Promise<MoveApprovedResult> {
  const key = input.order.trim().replace(/^#/, "");
  const name = input.to.trim();
  if (!key || !name) return { ok: false, code: "usage", message: "Say which order and who it goes to." };

  const plan = await withSystemContext(async (tx) => {
    const found = await tx
      .select({
        id: orders.id,
        businessId: orders.businessId,
        business: businesses.name,
        number: sql<string>`coalesce(${orders.platformOrderName}, ${orders.platformOrderId})`,
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
    const targets = await tx
      .select({ id: users.id, name: users.name, isAgent: designerProfiles.isAgent })
      .from(users)
      .innerJoin(designerBusinesses, and(eq(designerBusinesses.userId, users.id), eq(designerBusinesses.businessId, o.businessId)))
      .leftJoin(designerProfiles, eq(designerProfiles.userId, users.id))
      .where(and(eq(users.role, "designer"), eq(users.active, true), sql`lower(${users.name}) = lower(${name})`));
    if (targets.length !== 1) {
      return {
        ok: false as const,
        code: "designer",
        message: targets.length
          ? `${targets.length} designers called ${name} work for ${o.business}.`
          : `No active designer called ${name} works for ${o.business}.`,
      };
    }
    const [cur] = await tx
      .select({ id: users.id, name: users.name, isAgent: designerProfiles.isAgent })
      .from(assignments)
      .innerJoin(users, eq(users.id, assignments.designerId))
      .leftJoin(designerProfiles, eq(designerProfiles.userId, users.id))
      .where(and(eq(assignments.orderId, o.id), eq(assignments.active, true)))
      .limit(1);
    const byKey = input.by?.trim() || null;
    const [byUser] = byKey
      ? await tx
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.active, true), or(eq(users.name, byKey), sql`lower(${users.email}) = lower(${byKey})`)))
          .limit(1)
      : [];
    const hold = await loadReworkHold(tx, o.id);
    return { ok: true as const, o, target: targets[0], cur: cur ?? null, by: byUser?.id ?? null, hold, needsYes: !reworkAllows(hold, targets[0].id) };
  });
  if (!plan.ok) return plan;

  const { o, target, cur, hold, needsYes } = plan;
  const approved = input.approved?.trim() || null;
  const toName = target.name ?? name;
  const result = {
    ok: true as const,
    applied: false,
    order: o.number,
    from: cur?.name ?? null,
    to: toName,
    rework: hold.rework,
    needsYes,
    approvedBy: needsYes ? approved : null,
    noticeSent: false,
  };
  if (!input.apply) return result;
  if (needsYes && !approved) {
    return {
      ok: false,
      code: "needs_yes",
      message: `Order ${o.number} is a revision or failed QC: moving it to ${toName} needs an owner's yes (who and their words).`,
    };
  }

  const res = await reassignOrder(o.id, target.id, plan.by, { ownerApproved: needsYes ? approved : null });
  if (!res.ok) return { ok: false, code: res.code, message: res.message };
  result.applied = res.changed;
  // Both designers hear it the usual way; the AI designer has no phone.
  if (res.changed && cur && cur.id !== target.id && !cur.isAgent && !target.isAgent) {
    await withSystemContext((tx) =>
      sendDesignerReassigned(tx, {
        orderId: o.id,
        fromDesignerId: cur.id,
        toDesignerId: target.id,
        reason: input.reason?.trim() || DEFAULT_REASON,
      }),
    );
    result.noticeSent = true;
  }
  return result;
}
