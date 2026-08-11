import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { withUserContext } from "@/lib/db";
import { earnings, orders, users, type EarningBreakdown } from "@/lib/db/schema";
import { loadShellData } from "@/lib/shell/context";

export const dynamic = "force-dynamic";

function csv(value: unknown): string {
  const text = value == null ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function styleSummary(breakdown: EarningBreakdown[] | null): string {
  if (!breakdown?.length) return "";
  return [...new Set(breakdown.map((row) => row.style).filter(Boolean))].join(", ");
}

function breakdownText(breakdown: EarningBreakdown[] | null): string {
  if (!breakdown?.length) return "";
  return breakdown
    .map((row) => {
      const rate = row.rate ? `$${Number(row.rate).toFixed(2)}` : "needs rate";
      const amount = row.amount ? `$${Number(row.amount).toFixed(2)}` : "blocked";
      return `${row.figureCount} x ${row.style ?? "Unspecified"} @ ${rate} = ${amount}`;
    })
    .join("; ");
}

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user) return new NextResponse("Unauthorized", { status: 401 });
  if (session.user.role !== "admin") return new NextResponse("Forbidden", { status: 403 });

  const user = { id: session.user.id, role: session.user.role };
  const shell = await loadShellData(user);
  const url = new URL(request.url);
  const requestedBusiness = url.searchParams.get("business") ?? "";
  const businessId = shell.options.some((business) => business.id === requestedBusiness)
    ? requestedBusiness
    : shell.selected.id;
  const period = /^\d{4}-\d{2}$/.test(url.searchParams.get("period") ?? "")
    ? url.searchParams.get("period")!
    : new Date().toISOString().slice(0, 7);

  const rows = await withUserContext(user, (tx) =>
    tx
      .select({
        designerName: users.name,
        designerEmail: users.email,
        orderId: earnings.orderId,
        orderNumber: orders.platformOrderName,
        fallbackOrderNumber: orders.platformOrderId,
        figureCount: earnings.figureCount,
        rate: earnings.rate,
        amount: earnings.amount,
        breakdown: earnings.breakdown,
        status: earnings.status,
        blockedReason: earnings.blockedReason,
        paidAt: earnings.paidAt,
        voidedAt: earnings.voidedAt,
        voidReason: earnings.voidReason,
        createdAt: earnings.createdAt,
      })
      .from(earnings)
      .innerJoin(users, eq(users.id, earnings.designerId))
      .innerJoin(orders, eq(orders.id, earnings.orderId))
      .where(and(eq(earnings.businessId, businessId), eq(earnings.period, period)))
      .orderBy(desc(earnings.createdAt)),
  );

  const header = [
    "designer",
    "designer_email",
    "order_number",
    "style",
    "figure_count",
    "rate",
    "amount",
    "status",
    "blocked_reason",
    "breakdown",
    "created_at",
    "paid_at",
    "voided_at",
    "void_reason",
  ];
  const lines = [
    header.map(csv).join(","),
    ...rows.map((row) =>
      [
        row.designerName ?? row.designerEmail,
        row.designerEmail,
        row.orderNumber ?? row.fallbackOrderNumber,
        styleSummary(row.breakdown ?? null),
        row.figureCount,
        row.rate,
        row.amount,
        row.status,
        row.blockedReason,
        breakdownText(row.breakdown ?? null),
        row.createdAt.toISOString(),
        row.paidAt?.toISOString() ?? "",
        row.voidedAt?.toISOString() ?? "",
        row.voidReason ?? "",
      ]
        .map(csv)
        .join(","),
    ),
  ];

  return new NextResponse(lines.join("\n"), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="alphaos-payouts-${period}.csv"`,
    },
  });
}
