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
import { EmptyState, Page, PageHeader, TableShell } from "@/components/ui";
import { ArrowRight, ChevronDown, Mail, Package, Plus, Search, Sliders, X } from "@/components/ui/icons";
import { OrdersOperationsTable, type OrdersDashboardRow } from "@/components/orders/orders-operations-table";
import { OrdersFilterSelect } from "@/components/orders/orders-filter-select";
import { OrdersViewPreference } from "@/components/orders/orders-view-preference";
import { cn } from "@/lib/utils";
import { parseEtsyReceiptReview } from "@/lib/integrations/etsy/receipt-review";
import { resolveFigureCount, type NormalizedVariation } from "@/lib/integrations/figures";
import { stageTimer } from "@/lib/orders/stage-timers";
import { getEmailNeedsActionCounts } from "@/lib/email/outbox";
import { liveOrderWhere } from "@/lib/orders/archive";

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
  { key: "active", label: "All open", description: "Everything still needing attention" },
  { key: "overdue", label: "Overdue", description: "Past the due date" },
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

// The five counts that matter most, day to day. Everything else (the other
// saved views) is one tap away under "More views", never removed.
const PRIMARY_VIEW_KEYS: ViewKey[] = ["active", "overdue", "needs_details", "awaiting_qc", "awaiting_customer"];

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

function operationalStatusLabel(input: {
  status: string;
  needsReview: boolean;
  revisionCount: number;
  isFailedQc: boolean;
  physical: boolean;
  hasPrintJob: boolean;
  tracking: string | null;
  assignee: string | null;
}) {
  if (input.needsReview || input.status === "triage") return "Needs VA Review";
  if (input.isFailedQc) return "Awaiting Designer QC Fix";
  if (input.status === "in_design" && input.revisionCount > 0) return "Awaiting Designer Revision";
  if (input.status === "approved" && input.physical && !input.hasPrintJob) return "Ready to Ship";
  if (input.hasPrintJob && !input.tracking) return "Shipped - Awaiting Tracking";
  if (input.tracking) return "Completed With Tracking";

  switch (input.status) {
    case "awaiting_details":
      return "Awaiting VA Details";
    case "awaiting_photos":
      return "Awaiting Customer Photos";
    case "ready_to_assign":
      // Assigned -> waiting on the designer to start. Unassigned means auto-assign
      // found no free designer, so a VA must step in: surface it as Needs VA Review.
      return input.assignee ? "Assigned - Not Started" : "Needs VA Review";
    case "in_design":
      return "With Designer";
    case "awaiting_qc":
      return "Awaiting VA QC";
    case "awaiting_approval":
      return "Awaiting Customer Approval";
    case "approved":
      return "Approved";
    case "printing":
      return "In Print";
    case "shipped":
      return "Shipped";
    case "delivered":
      return "Delivered";
    case "complete":
      return "Complete";
    case "on_hold":
      return "On Hold";
    case "cancelled":
      return "Cancelled";
    case "fulfillment_only":
      return "Fulfilment Only";
    default:
      return titleCase(input.status);
  }
}

/**
 * Plain-English "why is this waiting on a VA" line for a Needs VA Review row.
 * Written for VAs with limited English: short words, one clear next step.
 * Returns null for any row that is not Needs VA Review.
 */
function reviewReasonText(input: {
  derivedStatus: string;
  status: string;
  email: string | null;
  unresolvedFigures: boolean;
  assignee: string | null;
}): string | null {
  if (input.derivedStatus !== "Needs VA Review") return null;
  if (input.status === "triage") return "This is a draft order. Open it and choose the right order type.";
  if (!input.email) return "No customer email yet. Add the customer's email so we can send the proof.";
  if (input.unresolvedFigures) return "We do not know how many figures. Open it and set the figure count.";
  if (!input.assignee) return "No designer is free for this order right now. Please assign it to a designer by hand.";
  return "Open this order and check what is missing.";
}

/**
 * The figure count we can show for an item: the stored value if resolved,
 * otherwise a read-time resolution from the raw variations via the built-in
 * default rules. Lets a count that IS present in the order (e.g. "Number of
 * Pets: 1") read as known even when the stored value predates the shop rule.
 */
function effectiveFigureCount(item: { figureCount: number | null; rawVariations: unknown }): number | null {
  if (item.figureCount != null) return item.figureCount;
  const variations = Array.isArray(item.rawVariations) ? (item.rawVariations as NormalizedVariation[]) : [];
  return variations.length ? resolveFigureCount(variations, null).count : null;
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
  const liveFilter = liveOrderWhere();

  const countRow = await withUserContext(user, async (tx) => {
    const countSel = Object.fromEntries(
      VIEWS.map((view) => [view.key, sql<number>`count(*) filter (where ${viewWhere(view.key)})::int`]),
    ) as Record<ViewKey, SQL<number>>;
    const [row] = await tx.select(countSel).from(orders).where(and(businessFilter, liveFilter));
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
    liveFilter,
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
            rawVariations: orderItems.rawVariations,
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
      // Resolve the figure count at read time too, so a count that is actually
      // present in the order (e.g. "Number of Pets: 1") never reads as unknown just
      // because the stored value predates the shop rule. Never widens review — it
      // only clears a stale figure-only needs_review flag.
      const unresolvedFigures = items.some((item) => effectiveFigureCount(item) == null);
      const needsReview =
        order.needsReview && (!order.customerEmail || unresolvedFigures);
      const derivedStatus = operationalStatusLabel({
        status: order.status,
        needsReview,
        revisionCount: order.revisionCount,
        isFailedQc,
        physical,
        hasPrintJob,
        tracking,
        assignee: order.assignee,
      });
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
      const reviewReason = reviewReasonText({
        derivedStatus,
        status: order.status,
        email: order.customerEmail,
        unresolvedFigures,
        assignee: order.assignee,
      });
      const action =
        timer.followUpDue
          ? { href: `/orders/${order.id}`, label: "Follow up" }
          : derivedStatus === "Needs VA Review"
            ? { href: `/orders/${order.id}`, label: "Review" }
          : order.status === "awaiting_photos"
            ? { href: `/orders/${order.id}/complete`, label: "Add photos" }
          : order.status === "awaiting_details"
          ? { href: `/orders/${order.id}/complete`, label: "Details" }
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
        reviewReason,
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
          items[0] && effectiveFigureCount(items[0]) != null ? `${effectiveFigureCount(items[0])} figures` : null,
          items[0]?.style ?? null,
          physical ? "Physical" : items.some((item) => item.productType === "digital") ? "Digital" : null,
        ].filter(Boolean).join(" · "),
        isOverdue: Boolean(order.dueAt && order.dueAt < new Date()),
        needsReview,
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

  const emailNeedsAction = await getEmailNeedsActionCounts(user, { businessId: selected.id });
  const emailAttention = emailNeedsAction.unmatched + emailNeedsAction.failed;

  // Filters that are set right now (the chips + the count on the button).
  const activeFilters: { key: string; label: string }[] = [];
  if (status) activeFilters.push({ key: "status", label: titleCase(status) });
  if (source) activeFilters.push({ key: "source", label: titleCase(source) });
  if (shop) activeFilters.push({ key: "shop", label: filterData.shops.find((s) => s.id === shop)?.name ?? "Shop" });
  if (designer) {
    activeFilters.push({
      key: "designer",
      label: designer === "unassigned" ? "Unassigned" : filterData.designers.find((d) => d.id === designer)?.name ?? "Designer",
    });
  }
  if (due) activeFilters.push({ key: "due", label: DUE_LABELS[due] ?? "Due" });
  const primaryViews = VIEWS.filter((view) => PRIMARY_VIEW_KEYS.includes(view.key));
  const moreViews = VIEWS.filter((view) => !PRIMARY_VIEW_KEYS.includes(view.key));
  const selectedIsMore = moreViews.some((view) => view.key === selectedView);
  const selectedViewMeta = VIEWS.find((view) => view.key === selectedView)!;

  return (
    <Page className="max-w-none">
      <PageHeader
        title="Orders"
        actions={
          <Link
            href="/orders/new"
            className="inline-flex h-10 items-center gap-2 rounded-input bg-pigment px-3.5 text-sm font-medium text-surface transition-opacity hover:opacity-90"
          >
            <Plus size={16} />
            New order
          </Link>
        }
      />
      <OrdersViewPreference view={selectedView} />

      {/* One row of clickable counts: the views that matter day to day. The
          other saved views live under "More views", never removed. */}
      <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1 [scrollbar-width:none] sm:flex-wrap sm:overflow-visible">
        {primaryViews.map((view) => (
          <ViewPill
            key={view.key}
            href={viewHref(currentParams, view.key)}
            active={view.key === selectedView}
            label={view.label}
            count={countRow[view.key]}
            title={view.description}
            tone={view.key === "overdue" ? "danger" : view.key === "active" ? "info" : "warning"}
          />
        ))}
        <details className="relative shrink-0">
          <summary
            className={cn(
              "flex h-10 cursor-pointer list-none items-center gap-1.5 rounded-full px-3.5 text-sm font-medium transition-colors [&::-webkit-details-marker]:hidden",
              selectedIsMore ? "bg-ink text-surface" : "bg-surface text-slate shadow-card hover:text-ink",
            )}
          >
            {selectedIsMore ? selectedViewMeta.label : "More views"}
            {selectedIsMore && <span className="rounded-full bg-surface/20 px-1.5 text-xs tabular-nums">{countRow[selectedView]}</span>}
            <ChevronDown size={14} />
          </summary>
          <div className="absolute left-0 top-12 z-30 w-64 rounded-card bg-surface p-1.5 shadow-lg">
            {moreViews.map((view) => (
              <Link
                key={view.key}
                href={viewHref(currentParams, view.key)}
                title={view.description}
                className={cn(
                  "flex items-center justify-between gap-3 rounded-input px-2.5 py-2 text-sm transition-colors hover:bg-canvas",
                  view.key === selectedView ? "font-semibold text-pigment" : "text-ink",
                )}
              >
                {view.label}
                <span className="text-xs tabular-nums text-slate">{countRow[view.key]}</span>
              </Link>
            ))}
          </div>
        </details>
      </div>

      {/* Search stays prominent. Everything else waits behind one button. */}
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <form className="relative min-w-0 flex-1 basis-64 sm:max-w-md">
            <Search size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-slate" />
            <input type="hidden" name="view" value={selectedView} />
            {activeFilters.map((f) => (
              <input key={f.key} type="hidden" name={f.key} value={params[f.key as keyof typeof params] ?? ""} />
            ))}
            <input
              name="q"
              defaultValue={q}
              placeholder="Search order number or customer"
              className="h-11 w-full rounded-full bg-surface pl-10 pr-4 text-sm text-ink shadow-card outline-none placeholder:text-slate/70 focus-visible:ring-2 focus-visible:ring-pigment"
            />
          </form>
          <details className="group relative">
            <summary
              className={cn(
                "flex h-11 cursor-pointer list-none items-center gap-2 rounded-full px-4 text-sm font-medium transition-colors [&::-webkit-details-marker]:hidden",
                activeFilters.length ? "bg-pigment-soft text-pigment" : "bg-surface text-slate shadow-card hover:text-ink",
              )}
            >
              <Sliders size={16} />
              Filters
              {activeFilters.length > 0 && (
                <span className="rounded-full bg-pigment px-1.5 text-xs font-semibold tabular-nums text-surface">{activeFilters.length}</span>
              )}
            </summary>
            <div className="fixed bottom-[5.5rem] left-3 right-[4.75rem] z-40 rounded-card bg-surface p-4 shadow-lg sm:absolute sm:inset-x-auto sm:bottom-auto sm:left-0 sm:top-13 sm:w-[36rem]">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
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
                  {Object.entries(DUE_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </OrdersFilterSelect>
              </div>
              {activeFilters.length > 0 && (
                <div className="mt-3 flex justify-end border-t border-line/60 pt-3">
                  <Link href={clearFiltersHref(currentParams)} className="text-sm font-medium text-pigment hover:text-ink">
                    Clear all filters
                  </Link>
                </div>
              )}
            </div>
          </details>
          {emailAttention > 0 && (
            <Link
              href="/emails"
              className="ml-auto inline-flex h-11 items-center gap-2 rounded-full px-3 text-sm text-slate transition-colors hover:text-ink"
            >
              <Mail size={15} className="text-rose" />
              <span>
                {emailAttention} email{emailAttention === 1 ? "" : "s"} need a reply
              </span>
              <ArrowRight size={14} />
            </Link>
          )}
        </div>
        {activeFilters.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {activeFilters.map((f) => (
              <Link
                key={f.key}
                href={filterHref(currentParams, f.key, "")}
                className="inline-flex h-8 items-center gap-1.5 rounded-full bg-pigment-soft pl-3 pr-2 text-xs font-medium text-pigment transition-colors hover:bg-pigment hover:text-surface"
                aria-label={`Remove filter ${f.label}`}
              >
                {f.label}
                <X size={12} />
              </Link>
            ))}
          </div>
        )}
      </div>

      <TableShell>
        {rows.length === 0 ? (
          <EmptyState
            icon={Package}
            headline={`Nothing in ${selectedViewMeta.label.toLowerCase()}`}
            body={activeFilters.length ? "Try clearing a filter." : "All clear here."}
            action={
              activeFilters.length ? (
                <Link href={clearFiltersHref(currentParams)} className="text-sm font-medium text-pigment hover:text-ink">
                  Clear filters
                </Link>
              ) : undefined
            }
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
            pageSize={pageSize}
            pageSizes={[...PAGE_SIZES]}
          />
        )}
      </TableShell>
    </Page>
  );
}

const DUE_LABELS: Record<string, string> = {
  overdue: "Overdue",
  today: "Due today",
  week: "Due next 7 days",
  none: "No due date",
};

function clearFiltersHref(params: URLSearchParams) {
  const next = new URLSearchParams(params);
  for (const key of ["status", "source", "shop", "designer", "due", "page"]) next.delete(key);
  return `/orders?${next.toString()}`;
}

function ViewPill({
  href,
  active,
  label,
  count,
  title,
  tone,
}: {
  href: string;
  active: boolean;
  label: string;
  count: number;
  title: string;
  tone: "info" | "warning" | "danger";
}) {
  const dot = { info: "bg-pigment", warning: "bg-amber", danger: "bg-rose" }[tone];
  return (
    <Link
      href={href}
      title={title}
      aria-current={active ? "page" : undefined}
      className={cn(
        "inline-flex h-10 shrink-0 items-center gap-2 rounded-full px-3.5 text-sm font-medium transition-colors",
        active ? "bg-ink text-surface" : "bg-surface text-slate shadow-card hover:text-ink",
      )}
    >
      {count > 0 && !active && <span className={cn("size-1.5 rounded-full", dot)} />}
      {label}
      <span className={cn("tabular-nums", active ? "text-surface/80" : "text-ink")}>{count}</span>
    </Link>
  );
}
