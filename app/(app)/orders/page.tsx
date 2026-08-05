import Link from "next/link";
import { redirect } from "next/navigation";
import { and, desc, eq, sql } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { withUserContext } from "@/lib/db";
import { loadShellData, ALL_BUSINESSES } from "@/lib/shell/context";
import {
  assignments,
  customers,
  orderItems,
  orders,
  shops,
  users,
} from "@/lib/db/schema";
import {
  Badge,
  EmptyState,
  FilterBar,
  Page,
  PageHeader,
  StatusChip,
  TableShell,
  type OrderStatus,
} from "@/components/ui";
import { Package, Plus, Search } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

type SearchParams = Promise<{ q?: string; status?: string }>;

const STATUS_FILTERS = [
  { value: "all", label: "All" },
  { value: "awaiting_details", label: "Details" },
  { value: "awaiting_photos", label: "Photos" },
  { value: "ready_to_assign", label: "Ready" },
  { value: "in_design", label: "Design" },
  { value: "awaiting_qc", label: "QC" },
  { value: "awaiting_approval", label: "Approval" },
] as const;

function fmtDate(date: Date | null) {
  if (!date) return "No due date";
  return new Intl.DateTimeFormat("en-AU", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date);
}

export default async function OrdersPage({
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
  const status =
    STATUS_FILTERS.some((filter) => filter.value === params.status) &&
    params.status !== "all"
      ? params.status
      : "";

  const businessFilter =
    selected.id === ALL_BUSINESSES
      ? sql`true`
      : eq(orders.businessId, selected.id);
  const queryFilter = q
    ? sql`(${orders.platformOrderName} ilike ${`%${q}%`} or ${orders.platformOrderId} ilike ${`%${q}%`} or ${customers.email} ilike ${`%${q}%`} or concat_ws(' ', ${customers.firstName}, ${customers.lastName}) ilike ${`%${q}%`})`
    : sql`true`;
  const statusFilter = status ? eq(orders.status, status as OrderStatus) : sql`true`;

  const rows = await withUserContext(user, (tx) =>
    tx
      .select({
        id: orders.id,
        number: orders.platformOrderName,
        fallbackNumber: orders.platformOrderId,
        status: orders.status,
        source: orders.source,
        dueAt: orders.dueAt,
        placedAt: orders.placedAt,
        shopName: shops.name,
        customerEmail: customers.email,
        customerFirst: customers.firstName,
        customerLast: customers.lastName,
        title: orderItems.title,
        assignee: users.name,
      })
      .from(orders)
      .leftJoin(shops, eq(shops.id, orders.shopId))
      .leftJoin(customers, eq(customers.id, orders.customerId))
      .leftJoin(orderItems, eq(orderItems.orderId, orders.id))
      .leftJoin(
        assignments,
        and(eq(assignments.orderId, orders.id), eq(assignments.active, true)),
      )
      .leftJoin(users, eq(users.id, assignments.designerId))
      .where(and(businessFilter, queryFilter, statusFilter))
      .orderBy(desc(orders.createdAt))
      .limit(100),
  );

  const now = new Date();

  return (
    <Page>
      <PageHeader
        title="Orders"
        description="Search, filter, and open imported or manually created orders."
        actions={
          <Link
            href="/orders/new"
            className="inline-flex h-10 items-center gap-2 rounded-input bg-pigment px-3 text-sm font-medium text-surface transition-opacity hover:opacity-90"
          >
            <Plus size={16} />
            New order
          </Link>
        }
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
            placeholder="Search order or customer"
            className="h-10 w-full rounded-input border border-line bg-canvas pl-9 pr-3 text-sm text-ink outline-none focus-visible:ring-2 focus-visible:ring-pigment"
          />
          {status && <input type="hidden" name="status" value={status} />}
        </form>
        <div className="flex flex-wrap gap-1">
          {STATUS_FILTERS.map((filter) => {
            const active = (status || "all") === filter.value;
            const href =
              filter.value === "all"
                ? q
                  ? `/orders?q=${encodeURIComponent(q)}`
                  : "/orders"
                : `/orders?status=${filter.value}${q ? `&q=${encodeURIComponent(q)}` : ""}`;
            return (
              <Link
                key={filter.value}
                href={href}
                className={cn(
                  "inline-flex h-9 items-center rounded-input px-3 text-sm font-medium transition-colors",
                  active
                    ? "bg-pigment text-surface"
                    : "text-slate hover:bg-canvas hover:text-ink",
                )}
              >
                {filter.label}
              </Link>
            );
          })}
        </div>
      </FilterBar>

      {rows.length === 0 ? (
        <TableShell>
          <EmptyState
            icon={Package}
            headline="No orders found"
            body="Try a different search or status filter."
          />
        </TableShell>
      ) : (
        <TableShell>
          <div className="hidden grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_9rem_8rem_8rem] gap-4 border-b border-line px-4 py-2 text-xs font-medium uppercase text-slate md:grid">
            <span>Order</span>
            <span>Item</span>
            <span>Status</span>
            <span>Owner</span>
            <span>Due</span>
          </div>
          <div className="divide-y divide-line">
            {rows.map((order) => {
              const name =
                [order.customerFirst, order.customerLast]
                  .filter(Boolean)
                  .join(" ") || order.customerEmail || "No customer linked";
              const overdue = order.dueAt ? order.dueAt < now : false;
              return (
                <Link
                  key={`${order.id}-${order.title ?? "item"}`}
                  href={`/orders/${order.id}`}
                  className="grid gap-2 px-4 py-3 transition-colors hover:bg-canvas md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_9rem_8rem_8rem] md:items-center md:gap-4"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-ink">
                      {order.number ?? order.fallbackNumber}
                    </p>
                    <p className="truncate text-xs text-slate">
                      {name} · {order.shopName ?? order.source}
                    </p>
                  </div>
                  <p className="truncate text-sm text-slate">
                    {order.title ?? "No item details"}
                  </p>
                  <div>
                    <StatusChip status={order.status as OrderStatus} />
                  </div>
                  <p className="truncate text-sm text-slate">
                    {order.assignee ?? "Unassigned"}
                  </p>
                  <div className="flex items-center gap-2">
                    {overdue && (
                      <Badge variant="danger" dot>
                        Overdue
                      </Badge>
                    )}
                    <span className="text-sm text-slate">
                      {fmtDate(order.dueAt)}
                    </span>
                  </div>
                </Link>
              );
            })}
          </div>
        </TableShell>
      )}
    </Page>
  );
}
