import { NextResponse, type NextRequest } from "next/server";
import { desc, eq } from "drizzle-orm";

import { isAlphaCaller } from "@/lib/alpha/auth";
import { withSystemContext } from "@/lib/db";
import { activityLog, assignments, customers, orderItems, orders, printJobs, shops, users } from "@/lib/db/schema";

export const runtime = "nodejs";

/**
 * GET /api/alpha/order/:id?audience=va|designer|admin
 * Order context for Alpha to answer a question. audience=designer strips the
 * customer down to a first name and drops contact details.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!isAlphaCaller(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const audience = req.nextUrl.searchParams.get("audience") || "va";
  const data = await withSystemContext(async (tx) => {
    const [o] = await tx
      .select({
        id: orders.id,
        number: orders.platformOrderName,
        status: orders.status,
        dueAt: orders.dueAt,
        source: orders.source,
        businessId: orders.businessId,
        shopName: shops.name,
        rawImport: orders.rawImport,
        revisionCount: orders.revisionCount,
        createdAt: orders.createdAt,
        customerFirst: customers.firstName,
        customerLast: customers.lastName,
        customerEmail: customers.email,
      })
      .from(orders)
      .leftJoin(shops, eq(shops.id, orders.shopId))
      .leftJoin(customers, eq(customers.id, orders.customerId))
      .where(eq(orders.id, id))
      .limit(1);
    if (!o) return null;
    const items = await tx.select({ title: orderItems.title, options: orderItems.options, figureCount: orderItems.figureCount, style: orderItems.style }).from(orderItems).where(eq(orderItems.orderId, id));
    const assigns = await tx
      .select({ designer: users.name, dueAt: assignments.dueAt, assignedAt: assignments.assignedAt, active: assignments.active })
      .from(assignments)
      .leftJoin(users, eq(users.id, assignments.designerId))
      .where(eq(assignments.orderId, id))
      .orderBy(desc(assignments.assignedAt))
      .limit(5);
    const prints = await tx.select({ provider: printJobs.provider, tracking: printJobs.trackingNumber, createdAt: printJobs.createdAt }).from(printJobs).where(eq(printJobs.orderId, id));
    const log = await tx.select({ action: activityLog.action, from: activityLog.fromState, to: activityLog.toState, at: activityLog.createdAt }).from(activityLog).where(eq(activityLog.orderId, id)).orderBy(desc(activityLog.createdAt)).limit(20);
    const customer = audience === "designer" ? { firstName: o.customerFirst } : { firstName: o.customerFirst, lastName: o.customerLast, email: o.customerEmail };
    const { customerFirst: _a, customerLast: _b, customerEmail: _c, ...rest } = o;
    void _a; void _b; void _c;
    return { ...rest, customer, items, assignments: assigns, printJobs: prints, activity: log };
  });
  if (!data) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(data);
}
