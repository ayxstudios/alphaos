import Link from "next/link";
import { redirect } from "next/navigation";
import { and, asc, eq, sql } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { withUserContext } from "@/lib/db";
import { loadShellData } from "@/lib/shell/context";
import { businesses, customers, orderItems, orders, shops } from "@/lib/db/schema";
import { parseEtsyReceiptReview } from "@/lib/integrations/etsy/receipt-review";
import { formatSyncTime, syncHealth } from "@/lib/integrations/sync-health";
import { getQueuedEmailCount, getUnmatchedCount } from "@/lib/email/outbox";
import { liveOrderSql, liveOrderWhere } from "@/lib/orders/archive";
import {
  Badge,
  DataPanel,
  EmptyState,
  Page,
  PageHeader,
  SectionHeader,
  StatCard,
  StatusChip,
  TableShell,
  type OrderStatus,
} from "@/components/ui";
import { AlertTriangle, Grid, ListChecks } from "@/components/ui/icons";

export const dynamic = "force-dynamic";

const CLOSED_STATUSES = ["delivered", "complete", "cancelled"] as const;

function fmtDate(date: Date | null) {
  if (!date) return "No due date";
  return new Intl.DateTimeFormat("en-AU", {
    day: "2-digit",
    month: "short",
  }).format(date);
}

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const user = { id: session.user.id, role: session.user.role };
  const { selected } = await loadShellData(user);
  const now = new Date();
  const businessFilter = eq(orders.businessId, selected.id);
  const liveFilter = liveOrderWhere();

  const [stats] = await withUserContext(user, (tx) =>
    tx
      .select({
        active: sql<number>`count(*) filter (where ${liveOrderSql()} and ${orders.status} not in ${CLOSED_STATUSES})::int`,
        overdue: sql<number>`count(*) filter (where ${liveOrderSql()} and ${orders.dueAt} < ${now} and ${orders.status} not in ${CLOSED_STATUSES})::int`,
        awaitingDetails: sql<number>`count(*) filter (where ${liveOrderSql()} and ${orders.status} = 'awaiting_details')::int`,
        awaitingPhotos: sql<number>`count(*) filter (where ${liveOrderSql()} and ${orders.status} = 'awaiting_photos')::int`,
        qc: sql<number>`count(*) filter (where ${liveOrderSql()} and ${orders.status} = 'awaiting_qc')::int`,
      })
      .from(orders)
      .where(businessFilter),
  );

  const attention = await withUserContext(user, (tx) =>
    tx
      .select({
        id: orders.id,
        number: orders.platformOrderName,
        fallbackNumber: orders.platformOrderId,
        status: orders.status,
        source: orders.source,
        dueAt: orders.dueAt,
        shopName: shops.name,
        customerEmail: customers.email,
        customerFirst: customers.firstName,
        customerLast: customers.lastName,
        rawImport: orders.rawImport,
        title: orderItems.title,
      })
      .from(orders)
      .leftJoin(shops, eq(shops.id, orders.shopId))
      .leftJoin(customers, eq(customers.id, orders.customerId))
      .leftJoin(orderItems, eq(orderItems.orderId, orders.id))
      .where(
        and(
          businessFilter,
          liveFilter,
          sql`(${orders.dueAt} < ${now} or ${orders.status} in ('awaiting_details', 'awaiting_photos', 'awaiting_qc'))`,
        ),
      )
      .orderBy(asc(orders.dueAt))
      .limit(8),
  );

  const shopHealth = await withUserContext(user, (tx) =>
    tx
      .select({
        id: shops.id,
        name: shops.name,
        platform: shops.platform,
        lastSyncAt: sql<string | null>`${shops.integrationConfig}->>${"lastSyncAt"}`,
      })
      .from(shops)
      .where(and(eq(shops.businessId, selected.id), eq(shops.active, true)))
      .orderBy(asc(shops.name)),
  );

  const [mailboxHealth, unmatchedReplies, queuedEmails] = await Promise.all([
    withUserContext(user, async (tx) => {
      const [row] = await tx
        .select({
          address: businesses.gmailAddress,
          historyId: businesses.gmailHistoryId,
          lastPolledAt: businesses.gmailLastPolledAt,
        })
        .from(businesses)
        .where(eq(businesses.id, selected.id))
        .limit(1);
      return row ?? { address: null, historyId: null, lastPolledAt: null };
    }),
    getUnmatchedCount(user, { businessId: selected.id }),
    getQueuedEmailCount(user, { businessId: selected.id }),
  ]);
  const mailboxLastPolledAt = mailboxHealth.lastPolledAt?.toISOString() ?? null;
  const mailboxConnected = Boolean(mailboxHealth.historyId);
  const mailboxPollHealth = mailboxConnected
    ? syncHealth(mailboxLastPolledAt, now)
    : "never";

  const actionTotal =
    (stats?.awaitingDetails ?? 0) +
    (stats?.awaitingPhotos ?? 0) +
    (stats?.qc ?? 0);

  return (
    <Page>
      <PageHeader
        title="Dashboard"
        description="Today&apos;s operational workload across the selected workspace."
        actions={
          <Link
            href="/orders"
            className="inline-flex h-10 items-center rounded-input bg-pigment px-3 text-sm font-medium text-surface transition-opacity hover:opacity-90"
          >
            View orders
          </Link>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <StatCard label="Active orders" value={stats?.active ?? 0} />
        <StatCard
          label="Overdue"
          value={stats?.overdue ?? 0}
          tone={(stats?.overdue ?? 0) > 0 ? "danger" : "neutral"}
        />
        <StatCard label="VA actions" value={actionTotal} tone="info" />
        <StatCard label="QC waiting" value={stats?.qc ?? 0} tone="warning" />
        <StatCard
          label="Unmatched replies"
          value={unmatchedReplies}
          tone={unmatchedReplies > 0 ? "danger" : "neutral"}
          detail="Need manual threading"
        />
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <DataPanel className="overflow-hidden">
          <div className="border-b border-line px-4 py-3">
            <SectionHeader
              title="Needs attention"
              description="Overdue orders and work waiting on VA action."
            />
          </div>
          {attention.length === 0 ? (
            <EmptyState
              icon={Grid}
              headline="No urgent work"
              body="Orders that are overdue, awaiting details, awaiting photos or awaiting QC will appear here."
            />
          ) : (
            <TableShell className="rounded-none border-0 shadow-none">
              <div className="divide-y divide-line">
                {attention.map((order) => {
                  const customerName =
                    [order.customerFirst, order.customerLast]
                      .filter(Boolean)
                      .join(" ") ||
                    order.customerEmail ||
                    parseEtsyReceiptReview(order.rawImport).buyerName ||
                    "Unknown customer";
                  const overdue = order.dueAt ? order.dueAt < now : false;
                  return (
                    <Link
                      key={`${order.id}-${order.title ?? "item"}`}
                      href={`/orders/${order.id}`}
                      className="grid gap-2 px-4 py-3 transition-colors hover:bg-canvas md:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_auto] md:items-center"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-ink">
                          {order.number ?? order.fallbackNumber}
                        </p>
                        <p className="truncate text-xs text-slate">
                          {customerName}
                        </p>
                      </div>
                      <p className="truncate text-sm text-slate">
                        {order.title ?? order.shopName ?? order.source}
                      </p>
                      <div className="flex flex-wrap items-center gap-2 md:justify-end">
                        {overdue && (
                          <Badge variant="danger" dot>
                            Overdue
                          </Badge>
                        )}
                        <StatusChip status={order.status as OrderStatus} />
                        <span className="text-xs text-slate">
                          {fmtDate(order.dueAt)}
                        </span>
                      </div>
                    </Link>
                  );
                })}
              </div>
            </TableShell>
          )}
        </DataPanel>

        <div className="flex flex-col gap-5">
          <DataPanel className="p-4">
            <SectionHeader title="Pipeline health" />
            <div className="mt-4 flex flex-col gap-3">
              <div className="border-b border-line pb-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-ink">Mailbox poll</p>
                    <p className="text-xs text-slate">
                      {mailboxHealth.address ?? "No mailbox connected"} · last poll{" "}
                      {formatSyncTime(mailboxLastPolledAt)}
                    </p>
                  </div>
                  {mailboxPollHealth === "ok" ? (
                    <Badge variant="success" dot>Healthy</Badge>
                  ) : (
                    <Badge variant="warning" dot>
                      {mailboxConnected ? "Stale" : "Not connected"}
                    </Badge>
                  )}
                </div>
              </div>

              <div className="border-b border-line pb-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-ink">Unmatched replies</p>
                    <p className="text-xs text-slate">
                      Replies captured without an order thread
                    </p>
                  </div>
                  {unmatchedReplies > 0 ? (
                    <Badge variant="danger" dot>{unmatchedReplies}</Badge>
                  ) : (
                    <Badge variant="success" dot>Clear</Badge>
                  )}
                </div>
              </div>

              <div className="border-b border-line pb-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-ink">Queued email</p>
                    <p className="text-xs text-slate">
                      Automated customer emails waiting for Gmail send
                    </p>
                  </div>
                  {queuedEmails > 0 ? (
                    <Badge variant="warning" dot>{queuedEmails}</Badge>
                  ) : (
                    <Badge variant="success" dot>Clear</Badge>
                  )}
                </div>
              </div>

              {shopHealth.map((shop) => {
                const health = syncHealth(shop.lastSyncAt, now);
                return (
                  <div key={shop.id} className="border-b border-line pb-3 last:border-0 last:pb-0">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-ink">{shop.name}</p>
                        <p className="text-xs text-slate">
                          {shop.platform === "shopify" ? "Shopify" : "Etsy"} · last successful sync{" "}
                          {formatSyncTime(shop.lastSyncAt)}
                        </p>
                      </div>
                      {health === "ok" ? (
                        <Badge variant="success" dot>Healthy</Badge>
                      ) : (
                        <Badge variant="warning" dot>
                          {health === "never" ? "Never synced" : "Stale"}
                        </Badge>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </DataPanel>

          <DataPanel className="p-4">
            <SectionHeader title="Orders workload" />
            <div className="mt-4 flex flex-col gap-3">
              <WorkloadLine
                label="Complete details"
                value={stats?.awaitingDetails ?? 0}
              />
              <WorkloadLine label="Awaiting photos" value={stats?.awaitingPhotos ?? 0} />
              <WorkloadLine label="Quality control" value={stats?.qc ?? 0} />
            </div>
            <Link
              href="/orders?view=active"
              className="mt-5 inline-flex h-10 w-full items-center justify-center gap-2 rounded-input border border-line bg-surface text-sm font-medium text-ink transition-colors hover:bg-canvas"
            >
              <ListChecks size={16} />
              Open orders
            </Link>
          </DataPanel>
        </div>
      </div>
    </Page>
  );
}

function WorkloadLine({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="flex items-center gap-2 text-sm text-slate">
        <AlertTriangle size={15} className="text-pigment" />
        {label}
      </span>
      <span className="text-sm font-semibold text-ink">{value}</span>
    </div>
  );
}
