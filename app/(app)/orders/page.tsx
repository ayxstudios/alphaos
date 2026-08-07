import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, sql, type SQL } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { withUserContext } from "@/lib/db";
import { loadShellData } from "@/lib/shell/context";
import {
  activityLog,
  assignments,
  customers,
  orderItems,
  orders,
  printJobs,
  qcChecks,
  shops,
  users,
} from "@/lib/db/schema";
import {
  EmptyState,
  FilterBar,
  Page,
  PageHeader,
  StatCard,
  TableShell,
} from "@/components/ui";
import { Package, Plus, Search } from "@/components/ui/icons";
import { OrdersOperationsTable, type OrdersDashboardRow } from "@/components/orders/orders-operations-table";
import { OrdersFilterSelect } from "@/components/orders/orders-filter-select";
import { OrdersViewPreference } from "@/components/orders/orders-view-preference";
import { cn } from "@/lib/utils";
import { parseEtsyReceiptReview } from "@/lib/integrations/etsy/receipt-review";
import { stageTimer } from "@/lib/orders/stage-timers";

export const dynamic = "force-dynamic";

type SearchParams = Promise<{
  q?: string;
  view?: string;
  status?: string;
  source?: string;
  shop?: string;
  designer?: string;
  due?: string;
  sort?: string;
  dir?: string;
  page?: string;
  pageSize?: string;
}>;

type ViewKey =
  | "active"
  | "overdue"
  | "needs_details"
  | "needs_photos"
  | "unassigned"
  | "awaiting_qc"
  | "revisions"
  | "failed_qc"
  | "awaiting_customer"
  | "ready_to_ship"
  | "shipped_waiting_tracking"
  | "completed_with_tracking"
  | "completed";

type SortKey = "created" | "order" | "customer" | "source" | "status" | "owner" | "ordered" | "due";
type SortDir = "asc" | "desc";

const ORDERS_VIEW_COOKIE = "orders_view";
const PAGE_SIZES = [20, 50, 100] as const;
const TERMINAL_STATES = ["complete", "cancelled", "delivered"] as const;
const ACTIVE_STATES = [
  "awaiting_details",
  "triage",
  "awaiting_photos",
  "ready_to_assign",
  "in_design",
  "awaiting_qc",
  "awaiting_approval",
  "approved",
  "printing",
  "shipped",
  "fulfillment_only",
  "on_hold",
] as const;
const STATUS_FILTERS = [
  "awaiting_details",
  "awaiting_photos",
  "ready_to_assign",
  "in_design",
  "awaiting_qc",
  "awaiting_approval",
  "approved",
  "printing",
  "shipped",
  "delivered",
  "complete",
  "on_hold",
  "cancelled",
  "fulfillment_only",
] as const;

const VIEWS: { key: ViewKey; label: string; description: string }[] = [
  { key: "active", label: "Active", description: "Everything still needing attention" },
  { key: "overdue", label: "Overdue", description: "Past the customer SLA" },
  { key: "needs_details", label: "Needs Details", description: "VA must complete imported order details" },
  { key: "needs_photos", label: "Needs Photos", description: "Waiting on reference photos" },
  { key: "unassigned", label: "Unassigned", description: "Ready but no active designer" },
  { key: "awaiting_qc", label: "Awaiting QC", description: "Ready for VA quality review" },
  { key: "revisions", label: "Revision", description: "Back in design after a revision" },
  { key: "failed_qc", label: "Failed QC", description: "Latest QC failed and is being fixed" },
  { key: "awaiting_customer", label: "Awaiting Customer", description: "Proof sent or awaiting approval" },
  { key: "ready_to_ship", label: "Ready to Ship", description: "Physical approved order without a print job" },
  { key: "shipped_waiting_tracking", label: "Shipped - Awaiting Tracking", description: "Print job exists without tracking" },
  { key: "completed_with_tracking", label: "Completed With Tracking", description: "Print job tracking has been captured" },
  { key: "completed", label: "Completed", description: "Completed, delivered, or cancelled orders" },
];

function intParam(value: string | undefined, fallback: number) {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function validView(value: string | undefined): ViewKey | null {
  return VIEWS.some((view) => view.key === value) ? (value as ViewKey) : null;
}

function validSort(value: string | undefined): SortKey {
  return ["created", "order", "customer", "source", "status", "owner", "ordered", "due"].includes(value ?? "")
    ? (value as SortKey)
    : "ordered";
}

function validDir(value: string | undefined): SortDir {
  return value === "asc" ? "asc" : "desc";
}

function titleCase(value: string | null | undefined) {
  if (!value) return "Unknown";
  return value.replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function orderLabel(number: string | null, fallback: string) {
  return number ?? fallback;
}

function customerName(row: {
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  rawImport: unknown;
}) {
  return (
    [row.firstName, row.lastName].filter(Boolean).join(" ") ||
    row.email ||
    parseEtsyReceiptReview(row.rawImport).buyerName ||
    "Unknown customer"
  );
}

function dateIso(date: Date | null) {
  return date ? date.toISOString() : null;
}

function physicalItemExistsSql() {
  return sql`exists (select 1 from order_items oi where oi.order_id = ${orders.id} and oi.product_type = 'physical')`;
}

function printJobExistsSql() {
  return sql`exists (select 1 from print_jobs pj where pj.order_id = ${orders.id})`;
}

function trackingExistsSql() {
  return sql`exists (select 1 from print_jobs pj where pj.order_id = ${orders.id} and pj.tracking_number is not null and pj.tracking_number <> '')`;
}

function latestQcFailedSql() {
  return sql`(
    select qc.result
    from qc_checks qc
    where qc.order_id = ${orders.id}
    order by qc.created_at desc
    limit 1
  ) = 'fail'`;
}

function viewWhere(view: ViewKey): SQL {
  switch (view) {
    case "active":
      return inArray(orders.status, [...ACTIVE_STATES]);
    case "overdue":
      return and(inArray(orders.status, [...ACTIVE_STATES]), isNotNull(orders.dueAt), lt(orders.dueAt, sql`now()`))!;
    case "needs_details":
      return eq(orders.status, "awaiting_details");
    case "needs_photos":
      return eq(orders.status, "awaiting_photos");
    case "unassigned":
      return and(
        eq(orders.status, "ready_to_assign"),
        sql`not exists (select 1 from assignments a where a.order_id = ${orders.id} and a.active)`,
      )!;
    case "awaiting_qc":
      return eq(orders.status, "awaiting_qc");
    case "revisions":
      return and(eq(orders.status, "in_design"), sql`${orders.revisionCount} > 0`, sql`not ${latestQcFailedSql()}`)!;
    case "failed_qc":
      return and(eq(orders.status, "in_design"), latestQcFailedSql())!;
    case "awaiting_customer":
      return eq(orders.status, "awaiting_approval");
    case "ready_to_ship":
      return and(eq(orders.status, "approved"), physicalItemExistsSql(), sql`not ${printJobExistsSql()}`)!;
    case "shipped_waiting_tracking":
      return and(printJobExistsSql(), sql`not ${trackingExistsSql()}`)!;
    case "completed_with_tracking":
      return trackingExistsSql();
    case "completed":
      return inArray(orders.status, [...TERMINAL_STATES]);
  }
}

function statusFilterWhere(status: string) {
  return STATUS_FILTERS.includes(status as (typeof STATUS_FILTERS)[number])
    ? eq(orders.status, status as (typeof STATUS_FILTERS)[number])
    : undefined;
}

function dueFilterWhere(due: string) {
  switch (due) {
    case "overdue":
      return and(isNotNull(orders.dueAt), lt(orders.dueAt, sql`now()`));
    case "today":
      return sql`${orders.dueAt} >= date_trunc('day', now()) and ${orders.dueAt} < date_trunc('day', now()) + interval '1 day'`;
    case "week":
      return sql`${orders.dueAt} >= now() and ${orders.dueAt} < now() + interval '7 days'`;
    case "none":
      return isNull(orders.dueAt);
    default:
      return undefined;
  }
}

function sortOrder(sort: SortKey, dir: SortDir, view: ViewKey) {
  const direction = dir === "asc" ? asc : desc;
  if (sort === "due") return [direction(orders.dueAt), desc(orders.createdAt)];
  if (sort === "order") return [direction(orders.platformOrderName), desc(orders.createdAt)];
  if (sort === "customer") return [direction(customers.firstName), direction(customers.lastName), desc(orders.createdAt)];
  if (sort === "source") return [direction(shops.name), desc(orders.createdAt)];
  if (sort === "status") return [direction(orders.status), desc(orders.createdAt)];
  if (sort === "owner") return [direction(users.name), desc(orders.createdAt)];
  if (sort === "ordered") return [direction(orders.placedAt), desc(orders.createdAt)];
  if (view === "overdue") return [asc(orders.dueAt), desc(orders.createdAt)];
  return [desc(orders.createdAt)];
}

function viewHref(params: URLSearchParams, view: ViewKey) {
  const next = new URLSearchParams(params);
  next.set("view", view);
  next.delete("page");
  return `/orders?${next.toString()}`;
}

function filterHref(params: URLSearchParams, key: string, value: string) {
  const next = new URLSearchParams(params);
  if (value) next.set(key, value);
  else next.delete(key);
  next.delete("page");
  return `/orders?${next.toString()}`;
}

export default async function OrdersPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const user = { id: session.user.id, role: session.user.role };
  if (user.role === "designer") redirect("/board");

  const [{ selected }, params, cookieStore] = await Promise.all([
    loadShellData(user),
    searchParams,
    cookies(),
  ]);

  const selectedView = validView(params.view);
  const q = params.q?.trim() ?? "";
  const source = params.source ?? "";
  const shop = params.shop ?? "";
  const designer = params.designer ?? "";
  const due = params.due ?? "";
  const status = params.status ?? "";
  const sort = validSort(params.sort);
  const dir = validDir(params.dir);
  const requestedPageSize = intParam(params.pageSize, 20);
  const pageSize = PAGE_SIZES.includes(requestedPageSize as (typeof PAGE_SIZES)[number])
    ? requestedPageSize
    : 20;
  const requestedPage = intParam(params.page, 1);
  const businessFilter = eq(orders.businessId, selected.id);

  const countRow = await withUserContext(user, async (tx) => {
    const countSel = Object.fromEntries(
      VIEWS.map((view) => [view.key, sql<number>`count(*) filter (where ${viewWhere(view.key)})::int`]),
    ) as Record<ViewKey, SQL<number>>;
    const [row] = await tx.select(countSel).from(orders).where(businessFilter);
    const counts = {} as Record<ViewKey, number>;
    for (const view of VIEWS) counts[view.key] = Number(row?.[view.key] ?? 0);
    return counts;
  });

  if (!selectedView) {
    const cookieView = validView(cookieStore.get(ORDERS_VIEW_COOKIE)?.value);
    const fallback = cookieView ?? (countRow.overdue > 0 ? "overdue" : "active");
    const next = new URLSearchParams();
    next.set("view", fallback);
    redirect(`/orders?${next.toString()}`);
  }

  const queryFilter = q
    ? sql`(${orders.platformOrderName} ilike ${`%${q}%`} or ${orders.platformOrderId} ilike ${`%${q}%`} or ${customers.email} ilike ${`%${q}%`} or concat_ws(' ', ${customers.firstName}, ${customers.lastName}) ilike ${`%${q}%`})`
    : undefined;
  const sourceFilter =
    source === "etsy" || source === "shopify" || source === "manual"
      ? eq(orders.source, source)
      : undefined;
  const shopFilter = shop ? eq(orders.shopId, shop) : undefined;
  const designerFilter =
    designer === "unassigned"
      ? isNull(assignments.designerId)
      : designer
        ? eq(assignments.designerId, designer)
        : undefined;
  const dueFilter = dueFilterWhere(due);
  const statusFilter = statusFilterWhere(status);
  const whereParts = [
    businessFilter,
    viewWhere(selectedView),
    queryFilter,
    sourceFilter,
    shopFilter,
    designerFilter,
    dueFilter,
    statusFilter,
  ].filter(Boolean) as SQL[];

  const where = whereParts.length ? and(...whereParts) : undefined;

  const [{ total }, rows, filterData] = await withUserContext(user, async (tx) => {
    const [count] = await tx
      .select({ total: sql<number>`count(distinct ${orders.id})::int` })
      .from(orders)
      .leftJoin(customers, eq(customers.id, orders.customerId))
      .leftJoin(
        assignments,
        and(eq(assignments.orderId, orders.id), eq(assignments.active, true)),
      )
      .where(where);

    const total = count?.total ?? 0;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(Math.max(requestedPage, 1), totalPages);
    const offset = (page - 1) * pageSize;

    const orderRows = await tx
      .select({
        id: orders.id,
        number: orders.platformOrderName,
        fallbackNumber: orders.platformOrderId,
        status: orders.status,
        source: orders.source,
        needsReview: orders.needsReview,
        revisionCount: orders.revisionCount,
        dueAt: orders.dueAt,
        placedAt: orders.placedAt,
        createdAt: orders.createdAt,
        updatedAt: orders.updatedAt,
        rawImport: orders.rawImport,
        shopName: shops.name,
        shopPlatform: shops.platform,
        customerId: customers.id,
        customerEmail: customers.email,
        customerFirst: customers.firstName,
        customerLast: customers.lastName,
        assigneeId: users.id,
        assignee: users.name,
      })
      .from(orders)
      .leftJoin(shops, eq(shops.id, orders.shopId))
      .leftJoin(customers, eq(customers.id, orders.customerId))
      .leftJoin(
        assignments,
        and(eq(assignments.orderId, orders.id), eq(assignments.active, true)),
      )
      .leftJoin(users, eq(users.id, assignments.designerId))
      .where(where)
      .orderBy(...sortOrder(sort, dir, selectedView))
      .limit(pageSize)
      .offset(offset);

    const ids = orderRows.map((order) => order.id);
    const itemRows = ids.length
      ? await tx
          .select({
            orderId: orderItems.orderId,
            title: orderItems.title,
            figureCount: orderItems.figureCount,
            style: orderItems.style,
            productType: orderItems.productType,
          })
          .from(orderItems)
          .where(inArray(orderItems.orderId, ids))
      : [];
    const qcRows = ids.length
      ? await tx
          .select({
            orderId: qcChecks.orderId,
            result: qcChecks.result,
            reason: qcChecks.reason,
            createdAt: qcChecks.createdAt,
          })
          .from(qcChecks)
          .where(inArray(qcChecks.orderId, ids))
          .orderBy(desc(qcChecks.createdAt))
      : [];
    const printRows = ids.length
      ? await tx
          .select({
            orderId: printJobs.orderId,
            provider: printJobs.provider,
            status: printJobs.status,
            trackingNumber: printJobs.trackingNumber,
            createdAt: printJobs.createdAt,
          })
          .from(printJobs)
          .where(inArray(printJobs.orderId, ids))
          .orderBy(desc(printJobs.createdAt))
      : [];
    const activityRows = ids.length
      ? await tx
          .select({
            orderId: activityLog.orderId,
            toState: activityLog.toState,
            createdAt: activityLog.createdAt,
          })
          .from(activityLog)
          .where(inArray(activityLog.orderId, ids))
          .orderBy(desc(activityLog.createdAt))
      : [];

    const itemMap = new Map<string, typeof itemRows>();
    for (const item of itemRows) itemMap.set(item.orderId, [...(itemMap.get(item.orderId) ?? []), item]);
    const latestQc = new Map<string, (typeof qcRows)[number]>();
    for (const qc of qcRows) if (!latestQc.has(qc.orderId)) latestQc.set(qc.orderId, qc);
    const printMap = new Map<string, typeof printRows>();
    for (const print of printRows) printMap.set(print.orderId, [...(printMap.get(print.orderId) ?? []), print]);
    const activityMap = new Map<string, typeof activityRows>();
    for (const event of activityRows) {
      if (!event.orderId) continue;
      activityMap.set(event.orderId, [...(activityMap.get(event.orderId) ?? []), event]);
    }

    const normalizedRows: OrdersDashboardRow[] = orderRows.map((order) => {
      const items = itemMap.get(order.id) ?? [];
      const prints = printMap.get(order.id) ?? [];
      const events = activityMap.get(order.id) ?? [];
      const qc = latestQc.get(order.id) ?? null;
      const physical = items.some((item) => item.productType === "physical");
      const tracking = prints.find((print) => print.trackingNumber)?.trackingNumber ?? null;
      const hasPrintJob = prints.length > 0;
      const isFailedQc = order.status === "in_design" && qc?.result === "fail";
      const derivedStatus =
        order.status === "triage" || order.needsReview
          ? "Needs Review"
          : isFailedQc
          ? "Failed QC"
          : order.status === "in_design" && order.revisionCount > 0
            ? "Revision"
            : order.status === "approved" && physical && !hasPrintJob
              ? "Ready to Ship"
              : hasPrintJob && !tracking
                ? "Shipped - Awaiting Tracking"
                : tracking
                  ? "Completed With Tracking"
                : titleCase(order.status);
      const stageStartedAt =
        isFailedQc
          ? qc?.createdAt ?? order.updatedAt
          : derivedStatus === "Ready to Ship"
            ? events.find((event) => event.toState === "approved")?.createdAt ?? order.updatedAt
            : derivedStatus === "Shipped - Awaiting Tracking"
              ? prints[0]?.createdAt ?? order.updatedAt
              : events.find((event) => event.toState === order.status)?.createdAt ??
                order.updatedAt ??
                order.createdAt;
      const timer = stageTimer({
        status: order.status,
        derivedStatus,
        isPhysical: physical,
        stageStartedAt: dateIso(stageStartedAt),
      });
      const action =
        timer.followUpDue
          ? { href: `/orders/${order.id}`, label: "Follow up" }
          : order.status === "awaiting_photos"
            ? { href: `/orders/${order.id}/complete`, label: "Add photos" }
          : order.status === "awaiting_details"
          ? { href: `/orders/${order.id}/complete`, label: "Complete details" }
          : order.status === "awaiting_qc"
            ? { href: `/qc/${order.id}`, label: "Review QC" }
            : { href: `/orders/${order.id}`, label: "Open" };

      return {
        id: order.id,
        orderNumber: orderLabel(order.number, order.fallbackNumber),
        customer: customerName({
          firstName: order.customerFirst,
          lastName: order.customerLast,
          email: order.customerEmail,
          rawImport: order.rawImport,
        }),
        customerEmail: order.customerEmail,
        source: order.shopName ?? titleCase(order.source),
        platform: titleCase(order.shopPlatform ?? order.source),
        status: order.status,
        derivedStatus,
        sourceType: order.source,
        assignee: order.assignee ?? "Unassigned",
        assigneeId: order.assigneeId,
        dueAt: dateIso(order.dueAt),
        placedAt: dateIso(order.placedAt),
        createdAt: dateIso(order.createdAt),
        stageTimer: timer,
        itemTitle: items[0]?.title ?? "No item details",
        itemSummary: [
          items.length > 1 ? `${items.length} items` : null,
          items[0]?.figureCount != null ? `${items[0].figureCount} figures` : null,
          items[0]?.style ?? null,
          physical ? "Physical" : items.some((item) => item.productType === "digital") ? "Digital" : null,
        ].filter(Boolean).join(" · "),
        isOverdue: Boolean(order.dueAt && order.dueAt < new Date()),
        needsReview: order.needsReview,
        revisionCount: order.revisionCount,
        latestQcResult: qc?.result ?? null,
        latestQcReason: qc?.reason ?? null,
        hasPrintJob,
        trackingNumber: tracking,
        action,
      };
    });

    const shopsForFilter = await tx
      .select({ id: shops.id, name: shops.name, platform: shops.platform })
      .from(shops)
      .where(eq(shops.businessId, selected.id))
      .orderBy(asc(shops.name));
    const designersForFilter = await tx
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(and(eq(users.role, "designer"), eq(users.active, true)))
      .orderBy(asc(users.name));

    return [
      { total, page, offset, totalPages },
      normalizedRows,
      { shops: shopsForFilter, designers: designersForFilter },
    ] as const;
  });

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(requestedPage, 1), totalPages);
  const offset = (page - 1) * pageSize;
  const firstResult = total === 0 ? 0 : offset + 1;
  const lastResult = Math.min(offset + rows.length, total);
  const currentParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string" && value) currentParams.set(key, value);
  }
  currentParams.set("view", selectedView);

  return (
    <Page className="max-w-none">
      <PageHeader
        title="Orders"
        description="The VA operations dashboard for every order that needs attention."
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
      <OrdersViewPreference view={selectedView} />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Active work" value={countRow.active} detail="Open operational orders" tone="info" />
        <StatCard label="Overdue" value={countRow.overdue} detail="Past SLA" tone={countRow.overdue ? "danger" : "neutral"} />
        <StatCard label="Needs details" value={countRow.needs_details} detail="VA completion required" tone={countRow.needs_details ? "warning" : "neutral"} />
        <StatCard label="Awaiting QC" value={countRow.awaiting_qc} detail="Ready for review" tone={countRow.awaiting_qc ? "warning" : "neutral"} />
      </div>

      <FilterBar className="gap-1">
        {VIEWS.map((view) => {
          const active = view.key === selectedView;
          return (
            <Link
              key={view.key}
              href={viewHref(currentParams, view.key)}
              title={view.description}
              aria-current={active ? "page" : undefined}
              className={cn(
                "inline-flex h-9 items-center gap-2 rounded-input px-3 text-sm font-medium transition-colors",
                active
                  ? "bg-pigment text-surface"
                  : "text-slate hover:bg-canvas hover:text-ink",
              )}
            >
              {view.label}
              <span className={cn("rounded-full px-1.5 text-xs", active ? "bg-surface/20" : "bg-canvas text-slate")}>
                {countRow[view.key]}
              </span>
            </Link>
          );
        })}
      </FilterBar>

      <FilterBar className="items-end">
        <form className="relative min-w-0 flex-1 sm:max-w-sm">
          <Search
            size={16}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate"
          />
          <input type="hidden" name="view" value={selectedView} />
          <input
            name="q"
            defaultValue={q}
            placeholder="Search order or customer"
            className="h-10 w-full rounded-input border border-line bg-canvas pl-9 pr-3 text-sm text-ink outline-none focus-visible:ring-2 focus-visible:ring-pigment"
          />
        </form>

        <OrdersFilterSelect label="Status" value={status} paramName="status" currentParams={currentParams.toString()}>
          <option value="">All statuses</option>
          {STATUS_FILTERS.map((status) => (
            <option key={status} value={status}>{titleCase(status)}</option>
          ))}
        </OrdersFilterSelect>
        <OrdersFilterSelect label="Source" value={source} paramName="source" currentParams={currentParams.toString()}>
          <option value="">All sources</option>
          <option value="etsy">Etsy</option>
          <option value="shopify">Shopify</option>
          <option value="manual">Manual</option>
        </OrdersFilterSelect>
        <OrdersFilterSelect label="Shop" value={shop} paramName="shop" currentParams={currentParams.toString()}>
          <option value="">All shops</option>
          {filterData.shops.map((shop) => (
            <option key={shop.id} value={shop.id}>{shop.name}</option>
          ))}
        </OrdersFilterSelect>
        <OrdersFilterSelect label="Designer" value={designer} paramName="designer" currentParams={currentParams.toString()}>
          <option value="">All designers</option>
          <option value="unassigned">Unassigned</option>
          {filterData.designers.map((designer) => (
            <option key={designer.id} value={designer.id}>{designer.name ?? designer.email}</option>
          ))}
        </OrdersFilterSelect>
        <OrdersFilterSelect label="Due" value={due} paramName="due" currentParams={currentParams.toString()}>
          <option value="">Any due date</option>
          <option value="overdue">Overdue</option>
          <option value="today">Due today</option>
          <option value="week">Due next 7 days</option>
          <option value="none">No due date</option>
        </OrdersFilterSelect>
        <div className="ml-auto flex flex-wrap items-center gap-1">
          <span className="px-2 text-xs font-medium text-slate">Rows</span>
          {PAGE_SIZES.map((size) => (
            <Link
              key={size}
              href={filterHref(currentParams, "pageSize", String(size))}
              aria-current={pageSize === size ? "true" : undefined}
              className={cn(
                "inline-flex h-9 min-w-10 items-center justify-center rounded-input px-2 text-sm font-medium transition-colors",
                pageSize === size
                  ? "bg-ink text-surface"
                  : "text-slate hover:bg-canvas hover:text-ink",
              )}
            >
              {size}
            </Link>
          ))}
        </div>
      </FilterBar>

      <TableShell>
        {rows.length === 0 ? (
          <EmptyState
            icon={Package}
            headline="No orders in this view"
            body="Try another saved view or clear a column filter."
          />
        ) : (
          <OrdersOperationsTable
            rows={rows}
            designers={filterData.designers.map((designer) => ({
              id: designer.id,
              name: designer.name ?? designer.email,
            }))}
            sort={sort}
            dir={dir}
            currentParams={currentParams.toString()}
            page={page}
            totalPages={totalPages}
            firstResult={firstResult}
            lastResult={lastResult}
            total={total}
          />
        )}
      </TableShell>
    </Page>
  );
}
