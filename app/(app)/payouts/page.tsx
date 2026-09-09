import Link from "next/link";
import { redirect } from "next/navigation";
import { and, desc, eq } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { withUserContext } from "@/lib/db";
import { loadShellData } from "@/lib/shell/context";
import { earnings, orders, users, type EarningBreakdown } from "@/lib/db/schema";
import { Badge, Button, DataPanel, EmptyState, Input, Page, PageHeader, Select, TableShell } from "@/components/ui";
import { cn } from "@/lib/utils";
import { AlertTriangle } from "@/components/ui/icons";
import {
  MarkPeriodPaidButton,
  ResolveBlockedButton,
  VoidEarningForm,
} from "@/components/payouts/payout-actions";

export const dynamic = "force-dynamic";

type PayoutRow = {
  id: string;
  designerId: string;
  designerName: string;
  designerEmail: string;
  orderId: string;
  orderNumber: string;
  figureCount: number;
  rate: string | null;
  amount: string | null;
  breakdown: EarningBreakdown[] | null;
  status: "blocked" | "pending" | "paid" | "voided";
  blockedReason: string | null;
  paidAt: Date | null;
  voidedAt: Date | null;
  voidReason: string | null;
  createdAt: Date;
};

function currentPeriod(): string {
  return new Date().toISOString().slice(0, 7);
}

function money(value: string | number | null): string {
  if (value == null) return "Needs rate";
  return `$${Number(value).toFixed(2)}`;
}

function formatDate(date: Date | null): string {
  if (!date) return "-";
  return new Intl.DateTimeFormat("en-AU", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function styleSummary(breakdown: EarningBreakdown[] | null): string {
  if (!breakdown?.length) return "Unspecified";
  const styles = [...new Set(breakdown.map((row) => row.style).filter(Boolean))];
  return styles.length ? styles.join(", ") : "Unspecified";
}

function details(breakdown: EarningBreakdown[] | null): string {
  if (!breakdown?.length) return "No item breakdown";
  return breakdown
    .map((row) => {
      const rate = row.rate ? `$${Number(row.rate).toFixed(2)}` : "needs rate";
      const amount = row.amount ? `$${Number(row.amount).toFixed(2)}` : "blocked";
      return `${row.figureCount} x ${row.style ?? "Unspecified"} @ ${rate} = ${amount}`;
    })
    .join("; ");
}

export default async function PayoutsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const user = { id: session.user.id, role: session.user.role };
  if (user.role !== "admin") redirect("/dashboard");

  const shell = await loadShellData(user);
  const sp = await searchParams;
  const requestedBusiness = typeof sp.business === "string" ? sp.business : "";
  const businessId = shell.options.some((option) => option.id === requestedBusiness)
    ? requestedBusiness
    : shell.selected.id;
  const period = typeof sp.period === "string" && /^\d{4}-\d{2}$/.test(sp.period)
    ? sp.period
    : currentPeriod();
  const selectedDesigner = typeof sp.designer === "string" ? sp.designer : "";

  const rows = await withUserContext(user, async (tx) =>
    tx
      .select({
        id: earnings.id,
        designerId: earnings.designerId,
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

  const payoutRows: PayoutRow[] = rows.map((row) => ({
    id: row.id,
    designerId: row.designerId,
    designerName: row.designerName ?? row.designerEmail,
    designerEmail: row.designerEmail,
    orderId: row.orderId,
    orderNumber: row.orderNumber ?? row.fallbackOrderNumber,
    figureCount: row.figureCount,
    rate: row.rate,
    amount: row.amount,
    breakdown: row.breakdown ?? null,
    status: row.status,
    blockedReason: row.blockedReason,
    paidAt: row.paidAt,
    voidedAt: row.voidedAt,
    voidReason: row.voidReason,
    createdAt: row.createdAt,
  }));

  const blocked = payoutRows.filter((row) => row.status === "blocked");
  const voided = payoutRows.filter((row) => row.status === "voided");
  const active = payoutRows.filter((row) => row.status !== "voided");
  const designerIds = [...new Set(active.map((row) => row.designerId))];
  const summaries = designerIds.map((designerId) => {
    const designerRows = active.filter((row) => row.designerId === designerId);
    const first = designerRows[0];
    const pending = designerRows.filter((row) => row.status === "pending");
    const paid = designerRows.filter((row) => row.status === "paid");
    return {
      designerId,
      name: first.designerName,
      email: first.designerEmail,
      pendingCount: pending.length,
      pendingTotal: pending.reduce((sum, row) => sum + Number(row.amount ?? 0), 0),
      paidCount: paid.length,
      paidTotal: paid.reduce((sum, row) => sum + Number(row.amount ?? 0), 0),
      blockedCount: designerRows.filter((row) => row.status === "blocked").length,
    };
  });
  const detailRows = selectedDesigner ? payoutRows.filter((row) => row.designerId === selectedDesigner) : [];
  const qs = new URLSearchParams({ business: businessId, period });

  return (
    <Page>
      <PageHeader
        title="Payouts"
        description="What each designer has earned, captured as orders complete."
        actions={
          <a
            href={`/payouts/export?${qs.toString()}`}
            className="inline-flex h-10 items-center justify-center rounded-input bg-surface px-4 text-sm font-medium text-ink shadow-card transition-colors hover:bg-canvas"
          >
            Export CSV
          </a>
        }
      />

      <form className="flex flex-wrap items-center gap-2">
        <Select name="business" defaultValue={businessId} aria-label="Business" className="h-11 min-w-44 rounded-full border-0 bg-surface shadow-card">
          {shell.options.map((business) => (
            <option key={business.id} value={business.id}>{business.name}</option>
          ))}
        </Select>
        <Input name="period" type="month" defaultValue={period} aria-label="Period" className="h-11 w-44 rounded-full border-0 bg-surface shadow-card" />
        <Button type="submit" variant="ghost" className="h-11 rounded-full">Show</Button>
      </form>

      {blocked.length > 0 && (
        <DataPanel>
          <div className="flex items-center gap-2 border-b border-line/60 px-4 py-3">
            <AlertTriangle size={16} className="text-amber" />
            <h2 className="text-sm font-semibold text-ink">Needs a rate before it can be paid</h2>
            <Badge variant="warning">{blocked.length}</Badge>
          </div>
          <div className="divide-y divide-line/60">
            {blocked.map((row) => (
              <div key={row.id} className="grid grid-cols-1 gap-2 px-4 py-3 text-sm lg:grid-cols-[1fr_1fr_auto_auto] lg:items-center">
                <div>
                  <Link href={`/orders/${row.orderId}`} className="font-medium text-ink hover:text-pigment">
                    {row.orderNumber}
                  </Link>
                  <p className="text-xs text-slate">{row.designerName} · {styleSummary(row.breakdown)}</p>
                </div>
                <p className="text-amber">{row.blockedReason ?? "Missing payout configuration"}</p>
                <ResolveBlockedButton businessId={businessId} earningId={row.id} />
                <VoidEarningForm businessId={businessId} earningId={row.id} />
              </div>
            ))}
          </div>
        </DataPanel>
      )}

      <TableShell>
        {summaries.length === 0 ? (
          <EmptyState icon={AlertTriangle} headline="No earnings this period" body="Completed design work lands here once orders are marked complete." />
        ) : (
          <>
            <div className="hidden grid-cols-[minmax(0,1.4fr)_1fr_1fr_5rem_auto] gap-4 border-b border-line/60 px-4 py-2.5 text-xs font-medium text-slate md:grid">
              <span>Designer</span>
              <span>Pending</span>
              <span>Paid</span>
              <span>Blocked</span>
              <span className="text-right">Actions</span>
            </div>
            <div className="divide-y divide-line/60">
              {summaries.map((summary) => (
                <div
                  key={summary.designerId}
                  className="grid grid-cols-2 gap-x-4 gap-y-2 px-4 py-3.5 text-sm md:grid-cols-[minmax(0,1.4fr)_1fr_1fr_5rem_auto] md:items-center"
                >
                  <div className="col-span-2 min-w-0 md:col-span-1">
                    <p className="truncate font-medium text-ink">{summary.name}</p>
                    <p className="truncate text-xs text-slate">{summary.email}</p>
                  </div>
                  <p>
                    <span className="block text-xs text-slate md:hidden">Pending</span>
                    <span className="font-medium tabular-nums text-ink">{money(summary.pendingTotal)}</span>
                    <span className="text-slate"> · {summary.pendingCount} order{summary.pendingCount === 1 ? "" : "s"}</span>
                  </p>
                  <p>
                    <span className="block text-xs text-slate md:hidden">Paid</span>
                    <span className="tabular-nums text-ink">{money(summary.paidTotal)}</span>
                    <span className="text-slate"> · {summary.paidCount} order{summary.paidCount === 1 ? "" : "s"}</span>
                  </p>
                  <p className={cn("tabular-nums", summary.blockedCount ? "font-medium text-amber" : "text-slate")}>
                    <span className="block text-xs font-normal text-slate md:hidden">Blocked</span>
                    {summary.blockedCount}
                  </p>
                  <div className="col-span-2 flex justify-end gap-2 md:col-span-1">
                    <Link
                      href={`/payouts?business=${businessId}&period=${period}&designer=${summary.designerId}`}
                      className={cn(
                        "inline-flex h-8 items-center justify-center rounded-input px-3 text-sm font-medium transition-colors hover:bg-pigment-soft",
                        selectedDesigner === summary.designerId ? "bg-pigment-soft text-pigment" : "text-ink",
                      )}
                    >
                      View orders
                    </Link>
                    <MarkPeriodPaidButton businessId={businessId} designerId={summary.designerId} period={period} />
                  </div>
                </div>
              ))}
            </div>
            <p className="border-t border-line/60 px-4 py-2.5 text-xs text-slate">
              Rate changes only affect future earnings, or blocked ones you resolve by hand.
            </p>
          </>
        )}
      </TableShell>

      {selectedDesigner && (
        <DataPanel>
          <div className="border-b border-line/60 px-4 py-3">
            <h2 className="text-sm font-semibold text-ink">
              Orders for {summaries.find((s) => s.designerId === selectedDesigner)?.name ?? "this designer"}
            </h2>
          </div>
          <div className="divide-y divide-line/60">
            {detailRows.map((row) => (
              <div key={row.id} className="grid grid-cols-1 gap-2 px-4 py-3 text-sm lg:grid-cols-[1fr_1.5fr_auto_auto_auto] lg:items-center">
                <div>
                  <Link href={`/orders/${row.orderId}`} className="font-medium text-ink hover:text-pigment">
                    {row.orderNumber}
                  </Link>
                  <p className="text-xs text-slate">{formatDate(row.createdAt)}</p>
                </div>
                <p className="text-slate">{details(row.breakdown)}</p>
                <span>{row.figureCount} figure{row.figureCount === 1 ? "" : "s"}</span>
                <Badge variant={row.status === "blocked" ? "warning" : row.status === "voided" ? "danger" : row.status === "paid" ? "success" : "neutral"}>
                  {row.status}
                </Badge>
                <span className="text-right font-semibold text-ink">{money(row.amount)}</span>
              </div>
            ))}
          </div>
        </DataPanel>
      )}

      {voided.length > 0 && (
        <DataPanel>
          <div className="border-b border-line/60 px-4 py-3">
            <h2 className="text-sm font-semibold text-ink">Voided earnings</h2>
          </div>
          <div className="divide-y divide-line/60">
            {voided.map((row) => (
              <div key={row.id} className="grid grid-cols-1 gap-2 px-4 py-3 text-sm md:grid-cols-[1fr_1fr_auto] md:items-center">
                <div>
                  <Link href={`/orders/${row.orderId}`} className="font-medium text-ink hover:text-pigment">
                    {row.orderNumber}
                  </Link>
                  <p className="text-xs text-slate">{row.designerName} · {formatDate(row.voidedAt)}</p>
                </div>
                <p className="text-slate">{row.voidReason ?? "No reason recorded"}</p>
                <span className="font-semibold text-ink">{money(row.amount)}</span>
              </div>
            ))}
          </div>
        </DataPanel>
      )}
    </Page>
  );
}
