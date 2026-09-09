import Link from "next/link";
import { redirect } from "next/navigation";
import { and, desc, eq, sql } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { withUserContext } from "@/lib/db";
import { customers, orders } from "@/lib/db/schema";
import { loadShellData } from "@/lib/shell/context";
import { EmptyState, Page, PageHeader, TableShell } from "@/components/ui";
import { Search, Users } from "@/components/ui/icons";

export const dynamic = "force-dynamic";

const PAGE_SIZES = [20, 50, 100] as const;

type SearchParams = Promise<{ q?: string; page?: string; pageSize?: string }>;

function customerName(row: {
  firstName: string | null;
  lastName: string | null;
  email: string;
}) {
  return [row.firstName, row.lastName].filter(Boolean).join(" ") || row.email;
}

function parsePositiveInt(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function pageHref(currentParams: URLSearchParams, page: number) {
  const params = new URLSearchParams(currentParams);
  if (page > 1) params.set("page", String(page));
  else params.delete("page");
  return `/customers?${params.toString()}`;
}

function pageSizeHref(currentParams: URLSearchParams, pageSize: number) {
  const params = new URLSearchParams(currentParams);
  params.set("pageSize", String(pageSize));
  params.delete("page");
  return `/customers?${params.toString()}`;
}

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const user = { id: session.user.id, role: session.user.role };
  const { selected } = await loadShellData(user);
  const params = await searchParams;
  const q = params.q?.trim() ?? "";
  const currentParams = new URLSearchParams();
  if (q) currentParams.set("q", q);
  const requestedPageSize = parsePositiveInt(params.pageSize, 20);
  const pageSize = PAGE_SIZES.includes(requestedPageSize as (typeof PAGE_SIZES)[number])
    ? requestedPageSize
    : 20;
  const requestedPage = parsePositiveInt(params.page, 1);
  const businessFilter = eq(customers.businessId, selected.id);
  const queryFilter = q
    ? sql`(${customers.email} ilike ${`%${q}%`} or concat_ws(' ', ${customers.firstName}, ${customers.lastName}) ilike ${`%${q}%`})`
    : sql`true`;
  const where = and(businessFilter, queryFilter);

  const total = await withUserContext(user, async (tx) => {
    const [row] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(customers)
      .where(where);
    return row?.count ?? 0;
  });
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requestedPage, totalPages);
  const offset = (page - 1) * pageSize;
  if (pageSize !== 20) currentParams.set("pageSize", String(pageSize));
  if (page > 1) currentParams.set("page", String(page));

  const rows = await withUserContext(user, (tx) =>
    tx
      .select({
        id: customers.id,
        email: customers.email,
        firstName: customers.firstName,
        lastName: customers.lastName,
        orderCount: sql<number>`count(${orders.id})::int`,
        latestOrderAt: sql<Date | null>`max(${orders.createdAt})`,
      })
      .from(customers)
      .leftJoin(orders, eq(orders.customerId, customers.id))
      .where(where)
      .groupBy(customers.id)
      .orderBy(desc(sql`max(${orders.createdAt})`), desc(customers.createdAt))
      .limit(pageSize)
      .offset(offset),
  );
  const firstResult = total === 0 ? 0 : offset + 1;
  const lastResult = Math.min(offset + rows.length, total);

  return (
    <Page>
      <PageHeader title="Customers" description="Everyone who has ordered, one record per email." />

      <form className="relative w-full max-w-md">
        <Search size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-slate" />
        <input
          name="q"
          defaultValue={q}
          placeholder="Search by name or email"
          className="h-11 w-full rounded-full bg-surface pl-10 pr-4 text-sm text-ink shadow-card outline-none placeholder:text-slate/70 focus-visible:ring-2 focus-visible:ring-pigment"
        />
        {pageSize !== 20 && <input type="hidden" name="pageSize" value={pageSize} />}
      </form>

      {rows.length === 0 ? (
        <TableShell>
          <EmptyState
            icon={Users}
            headline={q ? "No one matches that" : "No customers yet"}
            body={q ? "Try a shorter name or the email." : "Customers appear after an order has an email."}
          />
        </TableShell>
      ) : (
        <TableShell>
          <div className="hidden grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_6rem_10rem] gap-4 border-b border-line/60 px-4 py-2.5 text-xs font-medium text-slate md:grid">
            <span>Customer</span>
            <span>Email</span>
            <span>Orders</span>
            <span>Latest order</span>
          </div>
          <div className="divide-y divide-line/60">
            {rows.map((row) => (
              <Link
                key={row.id}
                href={`/customers/${row.id}`}
                className="grid grid-cols-1 gap-0.5 px-4 py-3.5 transition-colors hover:bg-canvas md:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_6rem_10rem] md:items-center md:gap-4"
              >
                <p className="truncate text-sm font-semibold text-ink">
                  {customerName(row)}
                </p>
                <p className="truncate text-sm text-slate">{row.email}</p>
                <p className="text-sm tabular-nums text-slate">
                  {row.orderCount}
                  <span className="md:hidden"> order{row.orderCount === 1 ? "" : "s"}</span>
                </p>
                <p className="text-sm text-slate">
                  {row.latestOrderAt
                    ? new Intl.DateTimeFormat("en-AU", {
                        day: "2-digit",
                        month: "short",
                        year: "numeric",
                      }).format(new Date(row.latestOrderAt))
                    : "No orders"}
                </p>
              </Link>
            ))}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line/60 px-4 py-2.5 text-sm text-slate">
            <div className="flex items-center gap-2">
              <span className="tabular-nums">{firstResult}-{lastResult} of {total}</span>
              <span className="text-line">·</span>
              <span className="text-xs">Rows</span>
              {PAGE_SIZES.map((size) => (
                <Link
                  key={size}
                  href={pageSizeHref(currentParams, size)}
                  aria-current={pageSize === size ? "true" : undefined}
                  className={
                    pageSize === size
                      ? "inline-flex h-8 min-w-8 items-center justify-center rounded-input bg-ink px-1.5 text-xs font-medium tabular-nums text-surface"
                      : "inline-flex h-8 min-w-8 items-center justify-center rounded-input px-1.5 text-xs font-medium tabular-nums text-slate transition-colors hover:bg-canvas hover:text-ink"
                  }
                >
                  {size}
                </Link>
              ))}
            </div>
            <Pagination currentParams={currentParams} page={page} totalPages={totalPages} />
          </div>
        </TableShell>
      )}
    </Page>
  );
}

function Pagination({
  currentParams,
  page,
  totalPages,
}: {
  currentParams: URLSearchParams;
  page: number;
  totalPages: number;
}) {
  return (
    <div className="flex items-center gap-2">
      <Link
        href={pageHref(currentParams, page - 1)}
        aria-disabled={page <= 1}
        className={
          page <= 1
            ? "pointer-events-none inline-flex h-8 items-center rounded-input px-2 text-sm font-medium text-slate/40"
            : "inline-flex h-8 items-center rounded-input px-2 text-sm font-medium text-pigment transition-colors hover:bg-pigment-soft"
        }
      >
        Previous
      </Link>
      <span className="text-xs tabular-nums text-slate">
        Page {page} of {totalPages}
      </span>
      <Link
        href={pageHref(currentParams, page + 1)}
        aria-disabled={page >= totalPages}
        className={
          page >= totalPages
            ? "pointer-events-none inline-flex h-8 items-center rounded-input px-2 text-sm font-medium text-slate/40"
            : "inline-flex h-8 items-center rounded-input px-2 text-sm font-medium text-pigment transition-colors hover:bg-pigment-soft"
        }
      >
        Next
      </Link>
    </div>
  );
}
