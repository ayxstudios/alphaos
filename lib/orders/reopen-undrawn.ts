// An order the AlphaOS import closed as COMPLETE although nothing was ever drawn
// (no designer history, no finals): CPS 4190816309 sat like that from 9 Oct while
// the buyer waited. complete -> in_design is a customer-revision edge and needs a
// designer; this is the one road for the other case. The order goes back to
// ready_to_assign with a timeline row, and the caller then hands it to the first
// designer (moveApproved, no yes needed for an order nobody held).
import { eq, or, sql } from "drizzle-orm";

import { withSystemContext } from "@/lib/db";
import { activityLog, assignments, assets, orders } from "@/lib/db/schema";

export type ReopenUndrawnResult =
  | { ok: true; applied: boolean; order: string; id: string }
  | { ok: false; code: string; message: string };

export async function reopenUndrawn(input: { order: string; why: string; apply?: boolean }): Promise<ReopenUndrawnResult> {
  const key = input.order.trim().replace(/^#/, "");
  const why = input.why.trim();
  if (!key || !why) return { ok: false, code: "usage", message: "Say which order and why." };
  return withSystemContext(async (tx) => {
    const found = await tx
      .select({
        id: orders.id,
        businessId: orders.businessId,
        status: orders.status,
        number: sql<string>`coalesce(${orders.platformOrderName}, ${orders.platformOrderId})`,
      })
      .from(orders)
      .where(or(sql`${orders.id}::text = ${key}`, eq(orders.platformOrderId, key), sql`lower(${orders.platformOrderName}) = lower(${key})`))
      .limit(3)
      .for("update");
    if (!found.length) return { ok: false as const, code: "not_found", message: `No order ${key}.` };
    if (found.length > 1) return { ok: false as const, code: "ambiguous", message: "Use the AlphaOS id." };
    const o = found[0];
    if (o.status !== "complete") return { ok: false as const, code: "status", message: `Order ${o.number} is ${o.status}, not complete.` };
    const hist = await tx.select({ id: assignments.id }).from(assignments).where(eq(assignments.orderId, o.id)).limit(1);
    if (hist.length) return { ok: false as const, code: "has_designer", message: "A designer held this order: not an undrawn import." };
    const finals = await tx.select({ id: assets.id, type: assets.type }).from(assets).where(eq(assets.orderId, o.id));
    if (finals.some((a) => a.type !== "reference")) return { ok: false as const, code: "has_art", message: "The order has art on it: not undrawn." };
    if (!input.apply) return { ok: true as const, applied: false, order: o.number, id: o.id };
    await tx.update(orders).set({ status: "ready_to_assign" }).where(eq(orders.id, o.id));
    await tx.insert(activityLog).values({
      businessId: o.businessId,
      orderId: o.id,
      actorId: null,
      action: "order.reopened_undrawn",
      metadata: { why: why.slice(0, 500), from: "complete", to: "ready_to_assign" },
    });
    return { ok: true as const, applied: true, order: o.number, id: o.id };
  });
}
