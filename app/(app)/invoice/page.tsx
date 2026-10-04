import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { and, asc, eq, inArray } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { withUserContext } from "@/lib/db";
import { businesses, earnings, orders, users, type EarningBreakdown } from "@/lib/db/schema";
import { Badge, DataPanel, EmptyState, Page, PageHeader } from "@/components/ui";
import { focusRing } from "@/components/ui/styles";
import { ArrowRight, Wallet } from "@/components/ui/icons";
import { cn, styleLabel } from "@/lib/utils";
import { formatAt } from "@/lib/time";
import { formatUsd, formatUsdPerFigure, USD_LABEL } from "@/lib/money";
import { currentUtcPeriod, invoiceHref, isPeriod, periodLabel, shiftPeriod } from "@/lib/invoice";

export const dynamic = "force-dynamic";

type InvoiceRow = {
  id: string;
  orderId: string;
  orderRef: string;
  businessName: string | null;
  figureCount: number;
  rate: string | null;
  amount: string | null;
  breakdown: EarningBreakdown[] | null;
  status: "blocked" | "pending" | "paid" | "voided";
  blockedReason: string | null;
  createdAt: Date;
};

function shortDate(date: Date): string {
  return formatAt(date, { day: "numeric", month: "short", year: "numeric" });
}

function figures(n: number): string {
  return `${n} figure${n === 1 ? "" : "s"}`;
}

function styles(breakdown: EarningBreakdown[] | null): string {
  const names = [...new Set((breakdown ?? []).map((b) => b.style?.trim()).filter((s): s is string => !!s).map(styleLabel))];
  return names.length ? names.join(", ") : "Unspecified";
}

/** "3 × $5.00/fig"; mixed rates list each part ("2 × $5.00/fig + 1 × $7.50/fig"). */
function quantity(row: InvoiceRow): string {
  if (row.rate) return `${row.figureCount} × ${formatUsdPerFigure(row.rate)}`;
  const parts = (row.breakdown ?? []).filter((b) => b.rate).map((b) => `${b.figureCount} × ${formatUsdPerFigure(b.rate as string)}`);
  return parts.length ? parts.join(" + ") : figures(row.figureCount);
}

const sum = (rows: InvoiceRow[]) => rows.reduce((total, row) => total + Number(row.amount ?? 0), 0);

export default async function InvoicePage({
  searchParams,
}: {
  searchParams: Promise<{ [k: string]: string | string[] | undefined }>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const user = { id: session.user.id, role: session.user.role };
  // A helper works a designer's board but never sees pay.
  if (user.role === "helper") redirect("/board");
  const isStaff = user.role === "admin" || user.role === "va";

  const sp = await searchParams;
  const designerParam = typeof sp.designer === "string" ? sp.designer : undefined;
  const period = isPeriod(sp.period) ? sp.period : currentUtcPeriod();

  // A designer only ever sees their own invoice; staff pass any designer id.
  if (!isStaff && designerParam !== user.id) redirect(invoiceHref(user.id, period));
  const designerId = isStaff ? designerParam : user.id;
  if (!designerId) redirect(user.role === "admin" ? "/payouts" : "/board");

  const { designer, rows } = await withUserContext(user, async (tx) => {
    const [designer] = await tx
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(eq(users.id, designerId))
      .limit(1);
    if (!designer) return { designer: null, rows: [] };
    const rows = await tx
      .select({
        id: earnings.id,
        orderId: earnings.orderId,
        orderNumber: orders.platformOrderName,
        fallbackOrderNumber: orders.platformOrderId,
        businessName: businesses.name,
        figureCount: earnings.figureCount,
        rate: earnings.rate,
        amount: earnings.amount,
        breakdown: earnings.breakdown,
        status: earnings.status,
        blockedReason: earnings.blockedReason,
        createdAt: earnings.createdAt,
      })
      .from(earnings)
      .leftJoin(orders, eq(orders.id, earnings.orderId))
      .leftJoin(businesses, eq(businesses.id, earnings.businessId))
      .where(
        and(
          eq(earnings.designerId, designerId),
          eq(earnings.period, period),
          inArray(earnings.status, ["pending", "paid", "blocked"]),
        ),
      )
      .orderBy(asc(earnings.createdAt));
    return { designer, rows };
  });
  if (!designer) notFound();

  const all: InvoiceRow[] = rows.map((row) => ({
    id: row.id,
    orderId: row.orderId,
    orderRef: row.orderNumber ?? row.fallbackOrderNumber ?? "Order",
    businessName: row.businessName,
    figureCount: row.figureCount,
    rate: row.rate,
    amount: row.amount,
    breakdown: row.breakdown ?? null,
    status: row.status,
    blockedReason: row.blockedReason,
    createdAt: row.createdAt,
  }));
  const lines = all.filter((row) => row.status === "pending" || row.status === "paid");
  const blocked = all.filter((row) => row.status === "blocked");
  const subtotal = sum(lines);
  const paid = sum(lines.filter((row) => row.status === "paid"));
  const due = sum(lines.filter((row) => row.status === "pending"));
  const businessNames = [...new Set(all.map((row) => row.businessName).filter((n): n is string => !!n))];
  const designerName = designer.name ?? designer.email;
  const label = periodLabel(period);
  const reference = `INV-${period.replace("-", "")}-${designer.id.slice(0, 6).toUpperCase()}`;
  const isCurrent = period === currentUtcPeriod();

  const navLink = cn(
    "inline-flex h-11 w-fit items-center gap-1.5 rounded-input border border-line bg-surface px-3 text-sm font-medium text-ink hover:bg-canvas lg:h-9",
    focusRing,
  );
  const back = !isStaff
    ? { href: "/me", label: "My Week" }
    : user.role === "admin"
      ? { href: `/payouts?period=${period}&designer=${designer.id}`, label: "Money" }
      : { href: `/designers/${designer.id}`, label: designerName };

  return (
    <Page className="max-w-4xl">
      <PageHeader
        title="Invoice"
        description={`${designerName} · ${label}`}
        eyebrow={
          <Link href={back.href} className="inline-flex min-h-11 items-center text-pigment hover:underline sm:min-h-0">
            {back.label}
          </Link>
        }
        actions={
          <nav aria-label="Invoice month" className="flex items-center gap-2 print:hidden">
            <Link href={invoiceHref(designer.id, shiftPeriod(period, -1))} className={navLink}>
              <ArrowRight size={15} className="rotate-180" />
              {periodLabel(shiftPeriod(period, -1))}
            </Link>
            {!isCurrent && (
              <Link href={invoiceHref(designer.id, shiftPeriod(period, 1))} className={navLink}>
                {periodLabel(shiftPeriod(period, 1))}
                <ArrowRight size={15} />
              </Link>
            )}
          </nav>
        }
      />

      <DataPanel className="overflow-hidden">
        {/* Invoice header: who pays, who is paid, which month. */}
        <div className="flex flex-col gap-4 border-b border-line/60 p-5 sm:flex-row sm:items-start sm:justify-between sm:p-6">
          <div className="min-w-0">
            <p className="text-xs font-medium text-slate">From</p>
            <p className="font-display text-xl font-semibold tracking-tight text-ink">
              {businessNames.length ? businessNames.join(" · ") : "AlphaOS"}
            </p>
            <p className="mt-3 text-xs font-medium text-slate">Designer</p>
            <p className="text-sm font-medium text-ink">{designerName}</p>
            {designer.name && <p className="text-xs text-slate">{designer.email}</p>}
          </div>
          <div className="flex flex-col gap-1 sm:items-end sm:text-right">
            <p className="font-display text-xl font-semibold tracking-tight text-ink">{label}</p>
            <p className="text-xs text-slate">
              {reference} · Issued {shortDate(new Date())}
            </p>
            <Badge variant="info" className="mt-1 w-fit">All amounts in {USD_LABEL}</Badge>
          </div>
        </div>

        {lines.length === 0 && blocked.length === 0 ? (
          <EmptyState
            icon={Wallet}
            headline={`No earnings in ${label}`}
            body="Pay for an order shows here once it is complete."
          />
        ) : (
          <>
            {lines.length === 0 ? (
              <p className="px-5 py-6 text-sm text-slate sm:px-6">Nothing payable yet this month.</p>
            ) : (
              <div>
                <div className="hidden grid-cols-[6.5rem_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.1fr)_6.5rem] gap-4 border-b border-line/60 px-6 py-2.5 text-xs font-medium text-slate md:grid">
                  <span>Date</span>
                  <span>Order</span>
                  <span>Style</span>
                  <span>Figures</span>
                  <span className="text-right">Amount ({USD_LABEL})</span>
                </div>
                <ul className="divide-y divide-line/60">
                  {lines.map((row) => (
                    <li
                      key={row.id}
                      className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 px-5 py-3 text-sm sm:px-6 md:grid-cols-[6.5rem_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.1fr)_6.5rem] md:items-center md:gap-4"
                    >
                      <span className="text-xs text-slate max-md:order-3 md:text-sm md:text-ink">{shortDate(row.createdAt)}</span>
                      <span className="min-w-0 max-md:order-1">
                        <Link href={`/orders/${row.orderId}`} className={cn("font-medium text-ink hover:text-pigment", focusRing)}>
                          {row.orderRef}
                        </Link>
                        {row.status === "paid" && (
                          <Badge variant="success" className="ml-2">Paid</Badge>
                        )}
                      </span>
                      <span className="truncate text-slate max-md:order-4 max-md:col-span-2">{styles(row.breakdown)}</span>
                      <span className="tabular-nums text-slate max-md:order-5 max-md:col-span-2">{quantity(row)}</span>
                      <span className="text-right font-semibold tabular-nums text-ink max-md:order-2">{formatUsd(row.amount ?? 0)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Totals */}
            <dl className="ml-auto flex w-full max-w-sm flex-col gap-2 border-t border-line/60 px-5 py-4 text-sm sm:px-6">
              <div className="flex items-baseline justify-between gap-4">
                <dt className="text-slate">Subtotal</dt>
                <dd className="tabular-nums text-ink">{formatUsd(subtotal)}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-4">
                <dt className="text-slate">Paid to date</dt>
                <dd className="tabular-nums text-ink">{paid ? `−${formatUsd(paid)}` : formatUsd(0)}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-4 border-t border-line/60 pt-2">
                <dt className="font-semibold text-ink">Balance due</dt>
                <dd className="font-display text-xl font-semibold tabular-nums text-ink">
                  {formatUsd(due)} <span className="text-xs font-medium text-slate">{USD_LABEL}</span>
                </dd>
              </div>
            </dl>
          </>
        )}
      </DataPanel>

      {blocked.length > 0 && (
        <DataPanel>
          <div className="flex items-center gap-2 border-b border-line/60 px-5 py-3 sm:px-6">
            <h2 className="text-sm font-semibold text-ink">On hold</h2>
            <Badge variant="warning">{blocked.length}</Badge>
            <span className="text-xs text-slate">Not in the totals until resolved</span>
          </div>
          <ul className="divide-y divide-line/60">
            {blocked.map((row) => (
              <li key={row.id} className="flex flex-col gap-1 px-5 py-3 text-sm sm:flex-row sm:items-center sm:justify-between sm:px-6">
                <span className="min-w-0">
                  <Link href={`/orders/${row.orderId}`} className={cn("font-medium text-ink hover:text-pigment", focusRing)}>
                    {row.orderRef}
                  </Link>
                  <span className="text-slate"> · {shortDate(row.createdAt)} · {figures(row.figureCount)}</span>
                </span>
                <span className="text-amber">{row.blockedReason ?? "Waiting on order details"}</span>
              </li>
            ))}
          </ul>
        </DataPanel>
      )}
    </Page>
  );
}
