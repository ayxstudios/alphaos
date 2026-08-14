import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { withUserContext } from "@/lib/db";
import {
  activityLog,
  assets,
  assignments,
  customers,
  messages,
  orderItems,
  orders,
  qcChecks,
  shops,
  users,
} from "@/lib/db/schema";
import {
  Badge,
  DataPanel,
  EmptyState,
  Page,
  PageHeader,
  SectionHeader,
  StatCard,
  StatusChip,
  type OrderStatus,
} from "@/components/ui";
import {
  Camera,
  CheckCircle,
  Inbox,
  Package,
  Pencil,
  Users,
} from "@/components/ui/icons";
import { ComposeButton } from "@/components/emails/compose-button";

export const dynamic = "force-dynamic";

type Params = Promise<{ id: string }>;

type Nameable = {
  firstName: string | null;
  lastName: string | null;
  email: string;
};

type OrderRow = {
  id: string;
  businessId: string;
  number: string | null;
  fallbackNumber: string;
  status: string;
  source: string;
  dueAt: Date | null;
  placedAt: Date | null;
  archivedAt: Date | null;
  createdAt: Date;
  notes: string | null;
  revisionCount: number;
  shopName: string | null;
  shopPlatform: string | null;
};

type ItemRow = {
  id: string;
  orderId: string;
  title: string | null;
  variation: string | null;
  figureCount: number | null;
  style: string | null;
  productType: string;
  options: unknown;
};

type AssignmentRow = {
  id: string;
  orderId: string;
  designerId: string;
  assignedBy: string | null;
  assignedAt: Date;
  dueAt: Date | null;
  active: boolean;
};

type QcRow = {
  id: string;
  orderId: string;
  vaId: string | null;
  result: string;
  reason: string | null;
  createdAt: Date;
};

type MessageRow = {
  id: string;
  orderId: string | null;
  direction: string;
  channel: string;
  status: string;
  subject: string | null;
  address: string | null;
  approvedBy: string | null;
  sentAt: Date | null;
  createdAt: Date;
};

type AssetCountRow = {
  orderId: string;
  type: string;
  count: number;
};

type ActivityRow = {
  id: string;
  orderId: string | null;
  actorId: string | null;
  action: string;
  fromState: string | null;
  toState: string | null;
  createdAt: Date;
};

function customerName(row: Nameable) {
  return [row.firstName, row.lastName].filter(Boolean).join(" ") || row.email;
}

function fmtDate(date: Date | null) {
  if (!date) return "Not set";
  return new Intl.DateTimeFormat("en-AU", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date);
}

function fmtDateTime(date: Date | null) {
  if (!date) return "Not set";
  return new Intl.DateTimeFormat("en-AU", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function titleCase(value: string | null | undefined) {
  if (!value) return "Unknown";
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function shortAction(value: string) {
  return value.replace(/^order\./, "").replaceAll("_", " ");
}

function groupByOrder<T extends { orderId: string | null }>(rows: T[]) {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    if (!row.orderId) continue;
    grouped.set(row.orderId, [...(grouped.get(row.orderId) ?? []), row]);
  }
  return grouped;
}

function optionLabels(options: unknown) {
  if (!Array.isArray(options)) return [];
  return options
    .map((option) => {
      if (!option || typeof option !== "object") return null;
      const record = option as Record<string, unknown>;
      const name = typeof record.name === "string" ? record.name : null;
      const value = typeof record.value === "string" ? record.value : null;
      return name && value ? `${name}: ${value}` : null;
    })
    .filter((label): label is string => Boolean(label));
}

function assetSummary(rows: AssetCountRow[]) {
  const count = (type: string) =>
    rows.find((row) => row.type === type)?.count ?? 0;
  return [
    `${count("reference")} reference`,
    `${count("submission")} work`,
    `${count("final")} final`,
  ].join(" · ");
}

function activeStatuses(order: { status: string; archivedAt: Date | null }) {
  return !order.archivedAt && !["delivered", "complete", "cancelled"].includes(order.status);
}

export default async function CustomerDetailPage({
  params,
}: {
  params: Params;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (session.user.role === "designer") redirect("/board");
  const user = { id: session.user.id, role: session.user.role };
  const { id } = await params;

  const data = await withUserContext(user, async (tx) => {
    const [customer] = await tx
      .select({
        id: customers.id,
        businessId: customers.businessId,
        email: customers.email,
        firstName: customers.firstName,
        lastName: customers.lastName,
        createdAt: customers.createdAt,
      })
      .from(customers)
      .where(eq(customers.id, id))
      .limit(1);

    if (!customer) return null;

    const orderRows: OrderRow[] = await tx
      .select({
        id: orders.id,
        businessId: orders.businessId,
        number: orders.platformOrderName,
        fallbackNumber: orders.platformOrderId,
        status: orders.status,
        source: orders.source,
        dueAt: orders.dueAt,
        placedAt: orders.placedAt,
        archivedAt: orders.archivedAt,
        createdAt: orders.createdAt,
        notes: orders.notes,
        revisionCount: orders.revisionCount,
        shopName: shops.name,
        shopPlatform: shops.platform,
      })
      .from(orders)
      .leftJoin(shops, eq(shops.id, orders.shopId))
      .where(eq(orders.customerId, customer.id))
      .orderBy(desc(orders.createdAt));

    const orderIds = orderRows.map((order) => order.id);

    const itemRows: ItemRow[] = orderIds.length
      ? await tx
          .select({
            id: orderItems.id,
            orderId: orderItems.orderId,
            title: orderItems.title,
            variation: orderItems.variation,
            figureCount: orderItems.figureCount,
            style: orderItems.style,
            productType: orderItems.productType,
            options: orderItems.options,
          })
          .from(orderItems)
          .where(inArray(orderItems.orderId, orderIds))
      : [];

    const assignmentRows: AssignmentRow[] = orderIds.length
      ? await tx
          .select({
            id: assignments.id,
            orderId: assignments.orderId,
            designerId: assignments.designerId,
            assignedBy: assignments.assignedBy,
            assignedAt: assignments.assignedAt,
            dueAt: assignments.dueAt,
            active: assignments.active,
          })
          .from(assignments)
          .where(inArray(assignments.orderId, orderIds))
          .orderBy(desc(assignments.assignedAt))
      : [];

    const qcRows: QcRow[] = orderIds.length
      ? await tx
          .select({
            id: qcChecks.id,
            orderId: qcChecks.orderId,
            vaId: qcChecks.vaId,
            result: qcChecks.result,
            reason: qcChecks.reason,
            createdAt: qcChecks.createdAt,
          })
          .from(qcChecks)
          .where(inArray(qcChecks.orderId, orderIds))
          .orderBy(desc(qcChecks.createdAt))
      : [];

    const messageFilter = orderIds.length
      ? or(eq(messages.customerId, customer.id), inArray(messages.orderId, orderIds))
      : eq(messages.customerId, customer.id);
    const messageRows: MessageRow[] = await tx
      .select({
        id: messages.id,
        orderId: messages.orderId,
        direction: messages.direction,
        channel: messages.channel,
        status: messages.status,
        subject: messages.subject,
        address: messages.address,
        approvedBy: messages.approvedBy,
        sentAt: messages.sentAt,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(messageFilter)
      .orderBy(desc(messages.createdAt))
      .limit(100);

    const assetCountRows: AssetCountRow[] = orderIds.length
      ? await tx
          .select({
            orderId: assets.orderId,
            type: assets.type,
            count: sql<number>`count(*)::int`,
          })
          .from(assets)
          .where(and(inArray(assets.orderId, orderIds), isNull(assets.deletedAt)))
          .groupBy(assets.orderId, assets.type)
      : [];

    const activityRows: ActivityRow[] = orderIds.length
      ? await tx
          .select({
            id: activityLog.id,
            orderId: activityLog.orderId,
            actorId: activityLog.actorId,
            action: activityLog.action,
            fromState: activityLog.fromState,
            toState: activityLog.toState,
            createdAt: activityLog.createdAt,
          })
          .from(activityLog)
          .where(inArray(activityLog.orderId, orderIds))
          .orderBy(desc(activityLog.createdAt))
          .limit(200)
      : [];

    const userIds = new Set<string>();
    for (const row of assignmentRows) {
      userIds.add(row.designerId);
      if (row.assignedBy) userIds.add(row.assignedBy);
    }
    for (const row of qcRows) {
      if (row.vaId) userIds.add(row.vaId);
    }
    for (const row of messageRows) {
      if (row.approvedBy) userIds.add(row.approvedBy);
    }
    for (const row of activityRows) {
      if (row.actorId) userIds.add(row.actorId);
    }

    const userRows = userIds.size
      ? await tx
          .select({ id: users.id, name: users.name, email: users.email, role: users.role })
          .from(users)
          .where(inArray(users.id, [...userIds]))
      : [];
    const userMap = new Map(
      userRows.map((row) => [
        row.id,
        row.name || row.email || titleCase(row.role),
      ]),
    );

    return {
      customer,
      orderRows,
      itemRows,
      assignmentRows,
      qcRows,
      messageRows,
      assetCountRows,
      activityRows,
      userMap,
    };
  });

  if (!data) notFound();

  const {
    customer,
    orderRows,
    itemRows,
    assignmentRows,
    qcRows,
    messageRows,
    assetCountRows,
    activityRows,
    userMap,
  } = data;

  const itemsByOrder = groupByOrder(itemRows);
  const assignmentsByOrder = groupByOrder(assignmentRows);
  const qcByOrder = groupByOrder(qcRows);
  const messagesByOrder = groupByOrder(messageRows);
  const assetsByOrder = groupByOrder(assetCountRows);
  const activityByOrder = groupByOrder(activityRows);
  const shopNames = new Set(orderRows.map((order) => order.shopName).filter(Boolean));
  const openOrders = orderRows.filter((order) => activeStatuses(order));
  const latestOrder = orderRows[0] ?? null;
  const latestMessage = messageRows[0] ?? null;
  const now = new Date();

  return (
    <Page>
      <PageHeader
        title={customerName(customer)}
        description={customer.email}
        eyebrow={
          <Link href="/customers" className="text-pigment hover:underline">
            Customers
          </Link>
        }
        actions={
          <ComposeButton
            businessId={customer.businessId}
            to={customer.email}
            subject={latestOrder ? `Re: ${latestOrder.number ?? latestOrder.fallbackNumber}` : ""}
            customerId={customer.id}
            orderId={latestOrder?.id ?? null}
            label="Compose"
          />
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Orders"
          value={orderRows.length}
          detail={`${openOrders.length} currently active`}
          tone={openOrders.length ? "info" : "neutral"}
        />
        <StatCard
          label="Bought from"
          value={shopNames.size || "None"}
          detail={shopNames.size ? [...shopNames].join(", ") : "No linked orders"}
        />
        <StatCard
          label="Messages"
          value={messageRows.length}
          detail={
            latestMessage
              ? `Latest ${fmtDateTime(latestMessage.sentAt ?? latestMessage.createdAt)}`
              : "No messages yet"
          }
        />
        <StatCard
          label="Spend"
          value="Not tracked"
          detail="Order totals are not stored yet"
          tone="warning"
        />
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex min-w-0 flex-col gap-5">
          <DataPanel className="overflow-hidden">
            <div className="border-b border-line px-4 py-3">
              <SectionHeader
                title="Orders and work cards"
                description="Linked orders, purchased items, designers, VAs, QC, messages, and assets."
              />
            </div>

            {orderRows.length === 0 ? (
              <EmptyState
                icon={Package}
                headline="No linked orders"
                body="Orders appear here after a VA enters or confirms the customer's email."
              />
            ) : (
              <div className="divide-y divide-line">
                {orderRows.map((order) => {
                  const orderItemsForOrder = itemsByOrder.get(order.id) ?? [];
                  const assignmentsForOrder = assignmentsByOrder.get(order.id) ?? [];
                  const qcsForOrder = qcByOrder.get(order.id) ?? [];
                  const messagesForOrder = messagesByOrder.get(order.id) ?? [];
                  const assetsForOrder = assetsByOrder.get(order.id) ?? [];
                  const activityForOrder = activityByOrder.get(order.id) ?? [];
                  const activeAssignment =
                    assignmentsForOrder.find((row) => row.active) ??
                    assignmentsForOrder[0] ??
                    null;
                  const latestQc = qcsForOrder[0] ?? null;
                  const latestOrderMessage = messagesForOrder[0] ?? null;
                  const latestActivity = activityForOrder[0] ?? null;
                  const overdue = order.dueAt ? order.dueAt < now : false;

                  return (
                    <article key={order.id} className="px-4 py-4">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <Link
                            href={`/orders/${order.id}`}
                            className="text-sm font-semibold text-ink hover:text-pigment"
                          >
                            {order.number ?? order.fallbackNumber}
                          </Link>
                          <p className="mt-1 text-xs text-slate">
                            {order.shopName ?? titleCase(order.source)} · Placed{" "}
                            {fmtDate(order.placedAt ?? order.createdAt)}
                          </p>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          {overdue && (
                            <Badge variant="danger" dot>
                              Overdue
                            </Badge>
                          )}
                          {order.revisionCount > 0 && (
                            <Badge variant="warning" dot>
                              Revision {order.revisionCount}
                            </Badge>
                          )}
                          <StatusChip status={order.status as OrderStatus} />
                        </div>
                      </div>

                      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
                        <div className="space-y-3">
                          {orderItemsForOrder.length === 0 ? (
                            <p className="text-sm text-slate">No item details saved.</p>
                          ) : (
                            orderItemsForOrder.map((item) => {
                              const labels = optionLabels(item.options);
                              return (
                                <div key={item.id} className="min-w-0">
                                  <p className="truncate text-sm font-medium text-ink">
                                    {item.title ?? "Untitled item"}
                                  </p>
                                  <div className="mt-1 flex flex-wrap gap-1.5">
                                    <Badge variant="neutral">
                                      {titleCase(item.productType)}
                                    </Badge>
                                    {item.figureCount != null && (
                                      <Badge variant="info">
                                        {item.figureCount} figure
                                        {item.figureCount === 1 ? "" : "s"}
                                      </Badge>
                                    )}
                                    {item.style && (
                                      <Badge variant="neutral">{item.style}</Badge>
                                    )}
                                    {item.variation && (
                                      <Badge variant="neutral">{item.variation}</Badge>
                                    )}
                                  </div>
                                  {labels.length > 0 && (
                                    <p className="mt-2 line-clamp-2 text-xs text-slate">
                                      {labels.join(" · ")}
                                    </p>
                                  )}
                                </div>
                              );
                            })
                          )}
                          {order.notes && (
                            <p className="line-clamp-3 rounded-input bg-canvas p-3 text-sm text-ink">
                              {order.notes}
                            </p>
                          )}
                        </div>

                        <dl className="grid gap-2 text-sm">
                          <div className="flex items-center justify-between gap-3">
                            <dt className="text-slate">Due</dt>
                            <dd className="text-right font-medium text-ink">
                              {fmtDate(order.dueAt)}
                            </dd>
                          </div>
                          <div className="flex items-center justify-between gap-3">
                            <dt className="text-slate">Designer</dt>
                            <dd className="truncate text-right font-medium text-ink">
                              {activeAssignment
                                ? userMap.get(activeAssignment.designerId) ?? "Assigned"
                                : "Unassigned"}
                            </dd>
                          </div>
                          <div className="flex items-center justify-between gap-3">
                            <dt className="text-slate">Assigned by</dt>
                            <dd className="truncate text-right font-medium text-ink">
                              {activeAssignment?.assignedBy
                                ? userMap.get(activeAssignment.assignedBy) ?? "Staff"
                                : "Not assigned"}
                            </dd>
                          </div>
                          <div className="flex items-center justify-between gap-3">
                            <dt className="text-slate">QC / VA</dt>
                            <dd className="truncate text-right font-medium text-ink">
                              {latestQc
                                ? `${titleCase(latestQc.result)} by ${
                                    latestQc.vaId
                                      ? userMap.get(latestQc.vaId) ?? "VA"
                                      : "VA"
                                  }`
                                : "No QC yet"}
                            </dd>
                          </div>
                          <div className="flex items-center justify-between gap-3">
                            <dt className="text-slate">Messages</dt>
                            <dd className="truncate text-right font-medium text-ink">
                              {latestOrderMessage
                                ? `${messagesForOrder.length} · ${titleCase(
                                    latestOrderMessage.direction,
                                  )}`
                                : "None"}
                            </dd>
                          </div>
                          <div className="flex items-center justify-between gap-3">
                            <dt className="text-slate">Assets</dt>
                            <dd className="truncate text-right font-medium text-ink">
                              {assetSummary(assetsForOrder)}
                            </dd>
                          </div>
                          <div className="flex items-center justify-between gap-3">
                            <dt className="text-slate">Latest work</dt>
                            <dd className="truncate text-right font-medium text-ink">
                              {latestActivity
                                ? `${
                                    latestActivity.actorId
                                      ? userMap.get(latestActivity.actorId) ?? "Staff"
                                      : "System"
                                  } · ${shortAction(latestActivity.action)}`
                                : "No activity"}
                            </dd>
                          </div>
                        </dl>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </DataPanel>
        </div>

        <aside className="flex flex-col gap-5">
          <DataPanel className="p-4">
            <SectionHeader title="Customer" />
            <dl className="mt-4 grid gap-3 text-sm">
              <div>
                <dt className="text-xs font-medium uppercase text-slate">Name</dt>
                <dd className="mt-1 text-ink">{customerName(customer)}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase text-slate">Email</dt>
                <dd className="mt-1 break-all text-ink">{customer.email}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase text-slate">Created</dt>
                <dd className="mt-1 text-ink">{fmtDate(customer.createdAt)}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase text-slate">Latest order</dt>
                <dd className="mt-1 text-ink">
                  {latestOrder
                    ? fmtDate(latestOrder.placedAt ?? latestOrder.createdAt)
                    : "No orders"}
                </dd>
              </div>
            </dl>
          </DataPanel>

          <DataPanel className="overflow-hidden">
            <div className="border-b border-line px-4 py-3">
              <SectionHeader title="Communication" />
            </div>
            {messageRows.length === 0 ? (
              <EmptyState
                icon={Inbox}
                headline="No messages"
                body="Customer messages linked to this customer or their orders will appear here."
              />
            ) : (
              <ul className="divide-y divide-line">
                {messageRows.slice(0, 8).map((message) => (
                  <li key={message.id} className="px-4 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge
                        variant={message.direction === "inbound" ? "info" : "neutral"}
                        dot
                      >
                        {message.direction === "inbound" ? "Customer" : "Outbound"}
                      </Badge>
                      <span className="text-xs text-slate">
                        {fmtDateTime(message.sentAt ?? message.createdAt)}
                      </span>
                    </div>
                    <p className="mt-2 line-clamp-2 text-sm font-medium text-ink">
                      {message.subject ?? titleCase(message.status)}
                    </p>
                    <p className="mt-1 text-xs text-slate">
                      {message.approvedBy
                        ? `Approved by ${userMap.get(message.approvedBy) ?? "staff"}`
                        : message.address ?? titleCase(message.channel)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </DataPanel>

          <DataPanel className="overflow-hidden">
            <div className="border-b border-line px-4 py-3">
              <SectionHeader title="Recent activity" />
            </div>
            {activityRows.length === 0 ? (
              <EmptyState
                icon={Users}
                headline="No activity"
                body="Workflow movement and team comments appear here after work starts."
              />
            ) : (
              <ul className="divide-y divide-line">
                {activityRows.slice(0, 10).map((event) => (
                  <li key={event.id} className="px-4 py-3 text-sm">
                    <div className="flex items-start gap-2">
                      {event.action === "comment" ? (
                        <Pencil size={15} className="mt-0.5 shrink-0 text-pigment" />
                      ) : event.toState === "complete" ? (
                        <CheckCircle size={15} className="mt-0.5 shrink-0 text-sage" />
                      ) : event.toState === "awaiting_photos" ? (
                        <Camera size={15} className="mt-0.5 shrink-0 text-slate" />
                      ) : (
                        <Package size={15} className="mt-0.5 shrink-0 text-slate" />
                      )}
                      <div className="min-w-0">
                        <p className="text-ink">
                          {event.actorId
                            ? userMap.get(event.actorId) ?? "Staff"
                            : "System"}{" "}
                          <span className="text-slate">
                            {shortAction(event.action)}
                          </span>
                        </p>
                        <p className="mt-0.5 text-xs text-slate">
                          {fmtDateTime(event.createdAt)}
                          {event.toState ? ` · ${titleCase(event.toState)}` : ""}
                        </p>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </DataPanel>
        </aside>
      </div>
    </Page>
  );
}
