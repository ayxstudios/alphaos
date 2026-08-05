import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { and, asc, desc, eq } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { withUserContext } from "@/lib/db";
import {
  assignments,
  customers,
  designerBusinesses,
  messages,
  orderItems,
  orders,
  printJobs,
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
  StatusChip,
  type OrderStatus,
} from "@/components/ui";
import { Camera, Inbox, Pencil, Plus } from "@/components/ui/icons";
import { parseEtsyReceiptReview } from "@/lib/integrations/etsy/receipt-review";
import { getCardDetail } from "@/lib/orders/card-detail";
import { OrderCommentForm } from "@/components/orders/order-comment-form";
import { OrderRevisionForm } from "@/components/orders/order-revision-form";
import { OrderReassignForm } from "@/components/orders/order-reassign-form";

export const dynamic = "force-dynamic";

function fmtDateTime(date: Date | string | null) {
  if (!date) return "Unknown";
  const value = typeof date === "string" ? new Date(date) : date;
  if (Number.isNaN(value.getTime())) return "Unknown";
  return new Intl.DateTimeFormat("en-AU", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
}

function customerDisplay(input: {
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  rawImport: unknown;
}) {
  return (
    [input.firstName, input.lastName].filter(Boolean).join(" ") ||
    parseEtsyReceiptReview(input.rawImport).buyerName ||
    input.email ||
    "Unknown customer"
  );
}

function titleCase(value: string | null | undefined) {
  if (!value) return "Unknown";
  return value.replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

const REVISION_FROM_STATUSES = new Set<OrderStatus>([
  "awaiting_approval",
  "approved",
  "printing",
  "shipped",
  "delivered",
  "complete",
]);

export default async function OrderDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const user = { id: session.user.id, role: session.user.role };
  const { id } = await params;

  const [order] = await withUserContext(user, (tx) =>
    tx
      .select({
        id: orders.id,
        businessId: orders.businessId,
        shopId: orders.shopId,
        platformOrderId: orders.platformOrderId,
        platformOrderName: orders.platformOrderName,
        source: orders.source,
        status: orders.status,
        dueAt: orders.dueAt,
        placedAt: orders.placedAt,
        createdAt: orders.createdAt,
        notes: orders.notes,
        rawImport: orders.rawImport,
        customerId: customers.id,
        customerEmail: customers.email,
        customerFirst: customers.firstName,
        customerLast: customers.lastName,
        shopName: shops.name,
        shopPlatform: shops.platform,
      })
      .from(orders)
      .innerJoin(shops, eq(shops.id, orders.shopId))
      .leftJoin(customers, eq(customers.id, orders.customerId))
      .where(eq(orders.id, id)),
  );

  if (!order) notFound();

  const [items, assignment, qcRows, printRows, timeline, detail, designers] = await Promise.all([
    withUserContext(user, (tx) =>
      tx
        .select({
          id: orderItems.id,
          title: orderItems.title,
          sku: orderItems.sku,
          variation: orderItems.variation,
          options: orderItems.options,
          figureCount: orderItems.figureCount,
          figureCountSource: orderItems.figureCountSource,
          style: orderItems.style,
          productType: orderItems.productType,
        })
        .from(orderItems)
        .where(eq(orderItems.orderId, id)),
    ),
    withUserContext(user, (tx) =>
      tx
        .select({ name: users.name, email: users.email })
        .from(assignments)
        .innerJoin(users, eq(users.id, assignments.designerId))
        .where(and(eq(assignments.orderId, id), eq(assignments.active, true)))
        .limit(1),
    ),
    withUserContext(user, (tx) =>
      tx
        .select({
          result: qcChecks.result,
          reason: qcChecks.reason,
          createdAt: qcChecks.createdAt,
        })
        .from(qcChecks)
        .where(eq(qcChecks.orderId, id))
        .orderBy(desc(qcChecks.createdAt))
        .limit(5),
    ),
    withUserContext(user, (tx) =>
      tx
        .select({
          provider: printJobs.provider,
          method: printJobs.method,
          status: printJobs.status,
          trackingNumber: printJobs.trackingNumber,
          createdAt: printJobs.createdAt,
        })
        .from(printJobs)
        .where(eq(printJobs.orderId, id))
        .orderBy(desc(printJobs.createdAt)),
    ),
    withUserContext(user, (tx) =>
      tx
        .select({
          id: messages.id,
          direction: messages.direction,
          status: messages.status,
          subject: messages.subject,
          body: messages.body,
          address: messages.address,
          sentAt: messages.sentAt,
          createdAt: messages.createdAt,
        })
        .from(messages)
        .where(eq(messages.orderId, id))
        .orderBy(desc(messages.createdAt))
        .limit(50),
    ),
    getCardDetail(user, id),
    withUserContext(user, (tx) =>
      tx
        .select({ id: users.id, name: users.name, email: users.email })
        .from(users)
        .innerJoin(designerBusinesses, eq(designerBusinesses.userId, users.id))
        .where(and(
          eq(users.role, "designer"),
          eq(users.active, true),
          eq(designerBusinesses.businessId, order.businessId),
        ))
        .orderBy(asc(users.name), asc(users.email)),
    ),
  ]);

  const customerName = customerDisplay({
    firstName: order.customerFirst,
    lastName: order.customerLast,
    email: order.customerEmail,
    rawImport: order.rawImport,
  });
  const assignee = assignment[0] ? (assignment[0].name ?? assignment[0].email) : "Unassigned";
  const latestQc = qcRows[0] ?? null;
  const references = detail.images.filter((image) => image.type === "reference");
  const sourceLabel = `${order.shopName} · ${titleCase(order.shopPlatform ?? order.source)}`;
  const editable = user.role === "admin" || user.role === "va";
  const canCreateRevision = editable && REVISION_FROM_STATUSES.has(order.status as OrderStatus);
  const revisionStarter =
    timeline.find((m) => m.direction === "inbound" && m.body)?.body ??
    "Customer requested a revision.";

  return (
    <Page className="max-w-6xl">
      <PageHeader
        title={order.platformOrderName ?? order.platformOrderId}
        description={`${sourceLabel} · Ordered ${fmtDateTime(order.placedAt ?? order.createdAt)}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <StatusChip status={order.status as OrderStatus} />
            {editable && (
              <Link
                href={`/orders/${order.id}/complete`}
                className="inline-flex h-9 items-center gap-2 rounded-input border border-line bg-surface px-3 text-sm font-medium text-ink hover:bg-canvas"
              >
                <Pencil size={15} />
                Edit
              </Link>
            )}
          </div>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_22rem]">
        <div className="flex flex-col gap-4">
          <DataPanel className="p-4">
            <SectionHeader title="Order summary" />
            <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <dt className="text-xs font-medium text-slate">Customer</dt>
                <dd className="font-medium text-ink">{customerName}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-slate">Email</dt>
                <dd className="font-medium text-ink">{order.customerEmail ?? "No email yet"}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-slate">Designer</dt>
                <dd className="font-medium text-ink">{assignee}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-slate">Due</dt>
                <dd className="font-medium text-ink">{fmtDateTime(order.dueAt)}</dd>
              </div>
            </dl>
            {order.notes && (
              <div className="mt-4 rounded-input bg-canvas p-3">
                <div className="text-xs font-medium text-slate">Designer notes / customer request</div>
                <p className="mt-1 whitespace-pre-wrap text-sm text-ink">{order.notes}</p>
              </div>
            )}
          </DataPanel>

          <DataPanel className="overflow-hidden">
            <div className="border-b border-line px-4 py-3">
              <SectionHeader title="Purchased items" />
            </div>
            {items.length === 0 ? (
              <EmptyState icon={Inbox} headline="No item details yet" body="Use Edit to add product, figure count, style and fulfilment." />
            ) : (
              <ul className="divide-y divide-line">
                {items.map((item) => (
                  <li key={item.id} className="px-4 py-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-medium text-ink">{item.title ?? "Untitled item"}</p>
                        {item.variation && <p className="mt-1 text-sm text-slate">{item.variation}</p>}
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        <Badge variant={item.productType === "physical" ? "info" : "success"}>
                          {titleCase(item.productType)}
                        </Badge>
                        {item.figureCount != null && <Badge variant="neutral">{item.figureCount} figures</Badge>}
                        {item.style && <Badge variant="neutral">{item.style}</Badge>}
                      </div>
                    </div>
                    {Array.isArray(item.options) && item.options.length > 0 && (
                      <dl className="mt-2 grid gap-1 text-sm sm:grid-cols-2">
                        {item.options.map((option) => (
                          <div key={`${option.name}-${option.value}`} className="flex gap-2">
                            <dt className="shrink-0 text-slate">{option.name}:</dt>
                            <dd className="font-medium text-ink">{option.value}</dd>
                          </div>
                        ))}
                      </dl>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </DataPanel>

          <DataPanel id="notes" className="overflow-hidden">
            <div className="border-b border-line px-4 py-3">
              <SectionHeader title="Notes & activity" />
            </div>
            <div className="p-4">
              {editable && <OrderCommentForm orderId={order.id} />}
              <ul className="mt-4 divide-y divide-line">
                {detail.events.length === 0 ? (
                  <li className="py-3 text-sm text-slate">No activity yet.</li>
                ) : (
                  detail.events
                    .slice()
                    .reverse()
                    .map((event) => (
                      <li key={event.id} className="py-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant={event.action === "comment" ? "info" : "neutral"} dot>
                            {event.action === "comment" ? "Note" : titleCase(event.action.replace(/^order\./, ""))}
                          </Badge>
                          <span className="text-xs text-slate">
                            {event.actorName ?? "System"} · {fmtDateTime(event.createdAt)}
                          </span>
                        </div>
                        {event.body && <p className="mt-2 whitespace-pre-wrap text-sm text-ink">{event.body}</p>}
                        {!event.body && event.fromState !== event.toState && (
                          <p className="mt-1 text-sm text-slate">
                            {event.fromState ? titleCase(event.fromState) : "Created"} → {event.toState ? titleCase(event.toState) : "Updated"}
                          </p>
                        )}
                      </li>
                    ))
                )}
              </ul>
            </div>
          </DataPanel>
        </div>

        <aside className="flex flex-col gap-4">
          {editable && (
            <DataPanel className="p-4">
              <SectionHeader title="Workflow actions" />
              <div className="mt-3 flex flex-col gap-4">
                <div className="rounded-input bg-canvas p-3">
                  <OrderRevisionForm
                    orderId={order.id}
                    initialNote={revisionStarter}
                    disabled={!canCreateRevision}
                  />
                  {!canCreateRevision && (
                    <p className="mt-2 text-xs text-slate">
                      Revision can be created from awaiting customer, approved, print, shipped, delivered or complete orders.
                    </p>
                  )}
                </div>
                <OrderReassignForm
                  orderId={order.id}
                  designers={designers.map((designer) => ({
                    id: designer.id,
                    name: designer.name ?? designer.email,
                  }))}
                />
              </div>
            </DataPanel>
          )}

          <DataPanel className="p-4">
            <SectionHeader title="Reference photos" />
            {references.length === 0 ? (
              <div className="mt-3 rounded-input border border-dashed border-line bg-canvas p-4 text-center">
                <Camera className="mx-auto text-slate" size={20} />
                <p className="mt-2 text-sm text-slate">No reference photos yet.</p>
                {editable && (
                  <Link
                    href={`/orders/${order.id}/complete`}
                    className="mt-3 inline-flex h-8 items-center gap-2 rounded-input bg-pigment px-3 text-sm font-medium text-surface"
                  >
                    <Plus size={14} />
                    Add photos
                  </Link>
                )}
              </div>
            ) : (
              <div className="mt-3 grid grid-cols-3 gap-2">
                {references.map((image) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img key={image.id} src={image.url} alt="" className="aspect-square rounded-input border border-line object-cover" />
                ))}
              </div>
            )}
          </DataPanel>

          <DataPanel className="p-4">
            <SectionHeader title="QC & print" />
            <dl className="mt-3 flex flex-col gap-3 text-sm">
              <div>
                <dt className="text-xs font-medium text-slate">Latest QC</dt>
                <dd className="font-medium text-ink">
                  {latestQc ? `${titleCase(latestQc.result)} · ${fmtDateTime(latestQc.createdAt)}` : "No QC yet"}
                </dd>
                {latestQc?.reason && <p className="mt-1 text-sm text-slate">{latestQc.reason}</p>}
              </div>
              <div>
                <dt className="text-xs font-medium text-slate">Print jobs</dt>
                <dd className="font-medium text-ink">{printRows.length ? `${printRows.length} print job(s)` : "No print job yet"}</dd>
              </div>
              {printRows.map((print, index) => (
                <div key={`${print.provider}-${print.createdAt.toISOString()}-${index}`} className="rounded-input bg-canvas p-2">
                  <p className="font-medium text-ink">{titleCase(print.provider)} · {titleCase(print.method)}</p>
                  <p className="text-xs text-slate">{print.status ?? "No provider status"} · {fmtDateTime(print.createdAt)}</p>
                  <p className="text-xs text-slate">{print.trackingNumber ? `Tracking ${print.trackingNumber}` : "No tracking yet"}</p>
                </div>
              ))}
            </dl>
          </DataPanel>

          <DataPanel className="overflow-hidden">
            <div className="border-b border-line px-4 py-3">
              <SectionHeader title="Messages" />
            </div>
            {timeline.length === 0 ? (
              <EmptyState
                icon={Inbox}
                headline="No messages yet"
                body="Customer email history for this order will appear here."
              />
            ) : (
              <ul className="divide-y divide-line">
                {timeline.map((m) => {
                  const inbound = m.direction === "inbound";
                  const when = m.sentAt ?? m.createdAt;
                  return (
                    <li key={m.id} className="px-4 py-3">
                      <div className="mb-1 flex flex-wrap items-center gap-2">
                        <Badge variant={inbound ? "info" : "neutral"} dot>
                          {inbound ? "Customer reply" : "Sent"}
                        </Badge>
                        {!inbound && m.status !== "sent" && (
                          <Badge variant={m.status === "failed" ? "danger" : "warning"} dot>
                            {m.status}
                          </Badge>
                        )}
                        <span className="text-xs text-slate">{fmtDateTime(when)}</span>
                      </div>
                      {m.subject && <p className="text-sm font-medium text-ink">{m.subject}</p>}
                      {m.body && <p className="mt-1 whitespace-pre-wrap text-sm text-slate line-clamp-5">{m.body}</p>}
                      {editable && inbound && m.body && (
                        <details className="mt-3 rounded-input bg-canvas p-2">
                          <summary className="cursor-pointer text-xs font-medium text-pigment">
                            Create revision from this email
                          </summary>
                          <div className="mt-2">
                            <OrderRevisionForm
                              orderId={order.id}
                              initialNote={m.body}
                              buttonLabel="Create revision"
                              disabled={!canCreateRevision}
                            />
                          </div>
                        </details>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </DataPanel>
        </aside>
      </div>
    </Page>
  );
}
