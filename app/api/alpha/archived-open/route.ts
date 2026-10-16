import { NextResponse, type NextRequest } from "next/server";
import { and, eq, sql } from "drizzle-orm";

import { isAlphaCaller } from "@/lib/alpha/auth";
import { withSystemContext } from "@/lib/db";
import { businesses, orders } from "@/lib/db/schema";
import { archivedUnfinishedWhere, isSettledArchiveReason } from "@/lib/orders/archive";
import { buyerWordsWhere } from "@/lib/reminders/buyer-replied";

export const runtime = "nodejs";

/**
 * GET /api/alpha/archived-open[?business=<id>]  Archived orders that are still
 * owed (not delivered, shipped, complete or cancelled), for Alpha's order
 * lookups and the owed-work checks. Clean slating audit 2026-10-16: 86 such
 * orders sat outside every live check. Order numbers and states only, no
 * customer data. Read-only: this list is for knowing, never for writing to
 * these buyers in bulk; an order is only acted on when its buyer writes
 * (lib/orders/reopen.ts) or a person decides.
 */
export async function GET(req: NextRequest) {
  if (!isAlphaCaller(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const business = req.nextUrl.searchParams.get("business");
  const now = new Date();
  const rows = await withSystemContext((tx) =>
    tx
      .select({
        id: orders.id,
        businessId: orders.businessId,
        businessName: businesses.name,
        number: orders.platformOrderName,
        platformOrderId: orders.platformOrderId,
        status: orders.status,
        source: orders.source,
        urgent: sql<boolean>`${orders.urgentAt} is not null`,
        placedAt: orders.placedAt,
        dueAt: orders.dueAt,
        archivedAt: orders.archivedAt,
        archiveReason: orders.archiveReason,
        // Table names spelled out so the subquery binds to the right table
        // whatever drizzle does with column names in the select list.
        lastBuyerWordsAt: sql<string | null>`(select max(messages.created_at) from messages
          where messages.order_id = orders.id and ${buyerWordsWhere()})`,
      })
      .from(orders)
      .innerJoin(businesses, eq(businesses.id, orders.businessId))
      .where(and(archivedUnfinishedWhere(), ...(business ? [eq(orders.businessId, business)] : [])))
      .orderBy(sql`${orders.dueAt} asc nulls last`),
  );
  const list = rows.map((r) => {
    const archivedAt = new Date(r.archivedAt!);
    const lastWords = r.lastBuyerWordsAt ? new Date(r.lastBuyerWordsAt) : null;
    return {
      id: r.id,
      businessId: r.businessId,
      businessName: r.businessName,
      number: r.number ?? r.platformOrderId,
      status: r.status,
      source: r.source,
      urgent: !!r.urgent,
      placedAt: r.placedAt,
      dueAt: r.dueAt,
      overdue: !!r.dueAt && new Date(r.dueAt) < now,
      archivedAt: archivedAt.toISOString(),
      archiveReason: r.archiveReason,
      // Archived on purpose with nothing owed (a duplicate, "ignore this order"): a person's call.
      settled: isSettledArchiveReason(r.archiveReason),
      lastBuyerWordsAt: lastWords?.toISOString() ?? null,
      buyerWroteSinceArchive: !!lastWords && lastWords > archivedAt,
    };
  });
  const byBusiness: Record<string, number> = {};
  for (const o of list) byBusiness[o.businessName] = (byBusiness[o.businessName] ?? 0) + 1;
  return NextResponse.json({
    generatedAt: now.toISOString(),
    total: list.length,
    overdue: list.filter((o) => o.overdue).length,
    buyerWroteSinceArchive: list.filter((o) => o.buyerWroteSinceArchive).length,
    byBusiness,
    orders: list,
  });
}
