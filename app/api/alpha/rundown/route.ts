import { NextResponse, type NextRequest } from "next/server";
import { and, count, eq, gte, inArray, isNull, lt } from "drizzle-orm";

import { isAlphaCaller } from "@/lib/alpha/auth";
import { withSystemContext } from "@/lib/db";
import { alphaEvents, assignments, businesses, messages, orders, printJobs } from "@/lib/db/schema";

export const runtime = "nodejs";

/**
 * GET /api/alpha/rundown  Numbers for the owners' morning rundown and for Alpha's
 * own sweeps. Aggregates only, no customer data.
 */
export async function GET(req: NextRequest) {
  if (!isAlphaCaller(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const now = new Date();
  const dayAgo = new Date(now.getTime() - 24 * 3600 * 1000);
  const out = await withSystemContext(async (tx) => {
    const byStatus = await tx
      .select({ businessId: orders.businessId, status: orders.status, n: count() })
      .from(orders)
      .groupBy(orders.businessId, orders.status);
    const overdue = await tx
      .select({ businessId: orders.businessId, n: count() })
      .from(orders)
      .where(and(lt(orders.dueAt, now), inArray(orders.status, ["awaiting_photos", "ready_to_assign", "in_design", "awaiting_qc", "awaiting_approval", "approved", "printing", "awaiting_details"])))
      .groupBy(orders.businessId);
    const newLast24h = await tx.select({ businessId: orders.businessId, n: count() }).from(orders).where(gte(orders.createdAt, dayAgo)).groupBy(orders.businessId);
    const shippedLast24h = await tx.select({ businessId: orders.businessId, n: count() }).from(orders).where(and(inArray(orders.status, ["shipped", "delivered", "complete"]), gte(orders.updatedAt, dayAgo))).groupBy(orders.businessId);
    const lateDesigners = await tx
      .select({ designerId: assignments.designerId, n: count() })
      .from(assignments)
      .innerJoin(orders, eq(orders.id, assignments.orderId))
      .where(and(eq(orders.status, "in_design"), lt(assignments.dueAt, now), eq(assignments.active, true)))
      .groupBy(assignments.designerId);
    const unansweredMessages = await tx
      .select({ businessId: messages.businessId, n: count() })
      .from(messages)
      .where(and(eq(messages.direction, "inbound"), isNull(messages.archivedAt)))
      .groupBy(messages.businessId);
    const printWaiting = await tx
      .select({ n: count() })
      .from(printJobs)
      .where(and(isNull(printJobs.trackingNumber), lt(printJobs.createdAt, new Date(now.getTime() - 3 * 24 * 3600 * 1000))));
    const alphaDecisions = await tx
      .select({ type: alphaEvents.type, n: count() })
      .from(alphaEvents)
      .where(gte(alphaEvents.createdAt, dayAgo))
      .groupBy(alphaEvents.type);
    const biz = await tx.select({ id: businesses.id, name: businesses.name }).from(businesses);
    return { generatedAt: now.toISOString(), businesses: biz, byStatus, overdue, newLast24h, shippedLast24h, lateDesigners, unansweredMessages, printWaitingOver3d: printWaiting[0]?.n ?? 0, alphaDecisions };
  });
  return NextResponse.json(out);
}
