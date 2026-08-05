import Link from "next/link";
import { redirect } from "next/navigation";
import { and, desc, eq, sql } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { withUserContext } from "@/lib/db";
import { customers, orders } from "@/lib/db/schema";
import { loadShellData } from "@/lib/shell/context";
import {
  EmptyState,
  FilterBar,
  Page,
  PageHeader,
  TableShell,
} from "@/components/ui";
import { Search, Users } from "@/components/ui/icons";

export const dynamic = "force-dynamic";

type SearchParams = Promise<{ q?: string }>;

function customerName(row: {
  firstName: string | null;
  lastName: string | null;
  email: string;
}) {
  return [row.firstName, row.lastName].filter(Boolean).join(" ") || row.email;
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
  const businessFilter = eq(customers.businessId, selected.id);
  const queryFilter = q
    ? sql`(${customers.email} ilike ${`%${q}%`} or concat_ws(' ', ${customers.firstName}, ${customers.lastName}) ilike ${`%${q}%`})`
    : sql`true`;

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
      .where(and(businessFilter, queryFilter))
      .groupBy(customers.id)
      .orderBy(desc(sql`max(${orders.createdAt})`))
      .limit(100),
  );

  return (
    <Page>
      <PageHeader
        title="Customers"
        description="Customer records are merged by normalized email inside each business."
      />

      <FilterBar>
        <form className="relative min-w-0 flex-1 sm:max-w-sm">
          <Search
            size={16}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate"
          />
          <input
            name="q"
            defaultValue={q}
            placeholder="Search customers"
            className="h-10 w-full rounded-input border border-line bg-canvas pl-9 pr-3 text-sm text-ink outline-none focus-visible:ring-2 focus-visible:ring-pigment"
          />
        </form>
      </FilterBar>

      {rows.length === 0 ? (
        <TableShell>
          <EmptyState
            icon={Users}
            headline="No customers found"
            body="Customers appear after an order has a manually entered email."
          />
        </TableShell>
      ) : (
        <TableShell>
          <div className="hidden grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_8rem_10rem] gap-4 border-b border-line px-4 py-2 text-xs font-medium uppercase text-slate md:grid">
            <span>Customer</span>
            <span>Email</span>
            <span>Orders</span>
            <span>Latest activity</span>
          </div>
          <div className="divide-y divide-line">
            {rows.map((row) => (
              <Link
                key={row.id}
                href={`/customers/${row.id}`}
                className="grid gap-1 px-4 py-3 transition-colors hover:bg-canvas md:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_8rem_10rem] md:items-center md:gap-4"
              >
                <p className="truncate text-sm font-semibold text-ink">
                  {customerName(row)}
                </p>
                <p className="truncate text-sm text-slate">{row.email}</p>
                <p className="text-sm text-slate">{row.orderCount}</p>
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
        </TableShell>
      )}
    </Page>
  );
}
