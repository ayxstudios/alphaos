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
import {
  ArrowRight,
  Calendar,
  Camera,
  ChevronDown,
  Inbox,
  Mail,
  Palette,
  Pencil,
  Plus,
  Truck,
  User,
  type IconProps,
} from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import { parseEtsyReceiptReview } from "@/lib/integrations/etsy/receipt-review";
import { getShopCredentials } from "@/lib/db/credentials";
import {
  fetchShopifyOrderProductMedia,
  freshShopifyCredentials,
  type ShopifyCredentials,
  type ShopifyProductMedia,
} from "@/lib/integrations/shopify";
import { getCardDetail } from "@/lib/orders/card-detail";
import { OrderCommentForm } from "@/components/orders/order-comment-form";
import { OrderRevisionForm } from "@/components/orders/order-revision-form";
import { OrderReassignForm } from "@/components/orders/order-reassign-form";
import { TrackingCompleteForm } from "@/components/orders/tracking-complete-form";

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

function mediaForItem(
  item: { sku: string | null; title: string | null; variation: string | null },
  media: ShopifyProductMedia[],
  index: number,
): ShopifyProductMedia | null {
  if (!media.length) return null;
  if (item.sku) {
    const bySku = media.find((m) => m.sku && m.sku === item.sku);
    if (bySku) return bySku;
  }
  const title = item.title?.trim().toLowerCase();
  const variation = item.variation?.trim().toLowerCase();
  const byTitle = media.find((m) => {
    if (title && m.title?.trim().toLowerCase() !== title) return false;
    if (variation && m.variantTitle) return variation.includes(m.variantTitle.trim().toLowerCase());
    return !!title;
  });
  return byTitle ?? media[index] ?? null;
}

/**
 * The single most useful thing to do next, in plain English. Shown in the header
 * so a VA knows the next step without reading the whole order. Mirrors the Orders
 * table's "next action" but computed from the detail page's own data.
 */
type NextAction =
  | { kind: "assign"; label: string }
  | { kind: "link"; label: string; cta: string; href: string }
  | { kind: "info"; label: string };

function nextSuggestedAction(input: {
  orderId: string;
  status: OrderStatus;
  hasDesigner: boolean;
  hasPrintJob: boolean;
  hasTracking: boolean;
  hasPhysical: boolean;
}): NextAction {
  const { orderId, status } = input;
  switch (status) {
    case "awaiting_details":
      return { kind: "link", label: "Complete the order details", cta: "Complete details", href: `/orders/${orderId}/complete` };
    case "triage":
      return { kind: "link", label: "Check the order and choose its type", cta: "Open", href: `/orders/${orderId}/complete` };
    case "awaiting_photos":
      return { kind: "link", label: "Waiting on the customer's photos", cta: "Add photos", href: `/orders/${orderId}/complete` };
    case "ready_to_assign":
      return input.hasDesigner
        ? { kind: "info", label: "Assigned — waiting for the designer to start" }
        : { kind: "assign", label: "Assign a designer" };
    case "in_design":
      return { kind: "info", label: "Waiting for the designer to finish" };
    case "awaiting_qc":
      return { kind: "link", label: "Ready for a quality check", cta: "Review QC", href: `/qc/${orderId}` };
    case "awaiting_approval":
      return { kind: "info", label: "Waiting for the customer to approve" };
    case "approved":
      return input.hasPhysical && !input.hasPrintJob
        ? { kind: "info", label: "Approved — start the print & ship job" }
        : { kind: "info", label: "Approved — move it forward" };
    case "printing":
      return { kind: "info", label: "Printing — waiting for it to ship" };
    case "shipped":
      return input.hasTracking
        ? { kind: "info", label: "Waiting for delivery" }
        : { kind: "info", label: "Add the tracking number below" };
    case "delivered":
      return { kind: "info", label: "Close the order once everything is done" };
    case "complete":
      return { kind: "info", label: "Done — nothing to do" };
    case "on_hold":
      return { kind: "info", label: "On hold — resume it when ready" };
    case "cancelled":
      return { kind: "info", label: "Cancelled — nothing to do" };
    case "fulfillment_only":
      return { kind: "info", label: "Fulfil the order" };
    default:
      return { kind: "info", label: "Open and review the order" };
  }
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
          trackingCompany: printJobs.trackingCompany,
          trackingUrl: printJobs.trackingUrl,
          shopifyFulfillmentId: printJobs.shopifyFulfillmentId,
          shopifySyncedAt: printJobs.shopifySyncedAt,
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

  const shopifyMedia =
    order.source === "shopify"
      ? await withUserContext(user, (tx) => getShopCredentials(tx, order.shopId))
          .then((creds) => freshShopifyCredentials(creds as ShopifyCredentials))
          .then((creds) => fetchShopifyOrderProductMedia(order.shopId, order.platformOrderId, creds))
          .catch((e) => {
            console.log(
              JSON.stringify({
                ts: new Date().toISOString(),
                level: "warn",
                integration: "shopify",
                orderId: order.id,
                platformOrderId: order.platformOrderId,
                event: "product_media_fetch_failed",
                error: e instanceof Error ? e.message : String(e),
              }),
            );
            return [] as ShopifyProductMedia[];
          })
      : [];

  const customerName = customerDisplay({
    firstName: order.customerFirst,
    lastName: order.customerLast,
    email: order.customerEmail,
    rawImport: order.rawImport,
  });
  const hasDesigner = Boolean(assignment[0]);
  const assignee = assignment[0] ? (assignment[0].name ?? assignment[0].email) : "Unassigned";
  const latestQc = qcRows[0] ?? null;
  const references = detail.images.filter((image) => image.type === "reference");
  const hasPhysicalItem = items.some((item) => item.productType === "physical");
  const latestTracking = printRows.find((print) => print.trackingNumber);
  const nextAction = nextSuggestedAction({
    orderId: order.id,
    status: order.status as OrderStatus,
    hasDesigner,
    hasPrintJob: printRows.length > 0,
    hasTracking: Boolean(latestTracking?.trackingNumber),
    hasPhysical: hasPhysicalItem,
  });
  const sourceLabel = `${order.shopName} · ${titleCase(order.shopPlatform ?? order.source)}`;
  const editable = user.role === "admin" || user.role === "va";
  const canCreateRevision = editable && REVISION_FROM_STATUSES.has(order.status as OrderStatus);
  const revisionStarter =
    timeline.find((m) => m.direction === "inbound" && m.body)?.body ??
    "Customer requested a revision.";

  return (
    <Page className="max-w-6xl">
      <PageHeader
        eyebrow={sourceLabel}
        title={order.platformOrderName ?? order.platformOrderId}
        description={`Ordered ${fmtDateTime(order.placedAt ?? order.createdAt)}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <StatusChip status={order.status as OrderStatus} />
            {editable && (
              <Link
                href={`/orders/${order.id}/complete`}
                className="inline-flex h-9 items-center gap-2 rounded-input border border-line bg-surface px-3 text-sm font-medium text-ink transition-colors hover:bg-canvas"
              >
                <Pencil size={15} />
                Edit
              </Link>
            )}
          </div>
        }
      />

      {/* The one thing to do next, in plain English — with the actual control to
          do it right here (assign a designer / go to QC / …). */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-card border border-line bg-surface px-4 py-3 text-sm shadow-sm">
        <span className="inline-flex shrink-0 items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-pigment">
          <ArrowRight size={14} />
          Next step
        </span>
        <span className="font-medium text-ink">{nextAction.label}</span>
        {nextAction.kind === "assign" && editable && (
          <div className="w-full sm:ml-auto sm:w-auto">
            <OrderReassignForm
              orderId={order.id}
              assigned={false}
              inline
              designers={designers.map((designer) => ({
                id: designer.id,
                name: designer.name ?? designer.email,
              }))}
            />
          </div>
        )}
        {nextAction.kind === "link" && (
          <Link
            href={nextAction.href}
            className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-input bg-pigment px-4 text-sm font-medium text-surface transition-opacity hover:opacity-90 sm:ml-auto"
          >
            {nextAction.cta}
            <ArrowRight size={14} />
          </Link>
        )}
      </div>

      {/* At-a-glance strip — the four facts a VA needs before anything else. */}
      <DataPanel className="overflow-hidden p-0">
        <div className="grid grid-cols-2 gap-px bg-line sm:grid-cols-4">
          <Fact icon={User} label="Customer" value={customerName} />
          <Fact icon={Mail} label="Email" value={order.customerEmail ?? "No email yet"} muted={!order.customerEmail} />
          <Fact icon={Palette} label="Designer" value={assignee} muted={assignee === "Unassigned"} />
          <Fact icon={Calendar} label="Due" value={fmtDateTime(order.dueAt)} />
        </div>
      </DataPanel>

      {order.notes && (
        <div className="rounded-card border border-pigment/20 bg-pigment-soft/40 p-4 shadow-sm">
          <div className="text-xs font-semibold uppercase tracking-wide text-pigment">
            Designer notes / customer request
          </div>
          <p className="mt-1.5 whitespace-pre-wrap text-sm text-ink">{order.notes}</p>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_22rem]">
        <div className="flex flex-col gap-4">

          <DataPanel className="overflow-hidden">
            <div className="border-b border-line px-4 py-3">
              <SectionHeader title="Purchased items" />
            </div>
            {items.length === 0 ? (
              <EmptyState icon={Inbox} headline="No item details yet" body="Use Edit to add product, figure count, style and fulfilment." />
            ) : (
              <ul className="divide-y divide-line">
                {items.map((item, index) => {
                  const media = order.source === "shopify" ? mediaForItem(item, shopifyMedia, index) : null;
                  const content = (
                    <>
                      {media?.imageUrl && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={media.imageUrl}
                          alt={media.imageAlt ?? item.title ?? "Shopify product"}
                          className="size-20 shrink-0 rounded-input border border-line object-cover"
                        />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="font-medium text-ink">{item.title ?? "Untitled item"}</p>
                            {media?.productUrl && (
                              <a
                                href={media.productUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="mt-2 inline-flex text-sm font-medium text-pigment hover:text-ink"
                              >
                                Open Shopify product
                              </a>
                            )}
                          </div>
                          <div className="flex flex-wrap gap-1.5">
                            <Badge variant={item.productType === "physical" ? "info" : "success"}>
                              {titleCase(item.productType)}
                            </Badge>
                            {item.figureCount != null && <Badge variant="neutral">{item.figureCount} figures</Badge>}
                            {item.style && <Badge variant="neutral">{item.style}</Badge>}
                          </div>
                        </div>
                        {Array.isArray(item.options) && item.options.length > 0 ? (
                          <dl className="mt-3 grid gap-x-4 gap-y-2 rounded-input bg-canvas p-3 text-sm sm:grid-cols-2">
                            {item.options.map((option) => (
                              <div key={`${option.name}-${option.value}`} className="min-w-0">
                                <dt className="text-xs text-slate">
                                  {String(option.name).replace(/[:：]\s*$/, "")}
                                </dt>
                                <dd className="mt-0.5 break-words font-medium text-ink">{option.value}</dd>
                              </div>
                            ))}
                          </dl>
                        ) : (
                          item.variation && (
                            <p className="mt-2 break-words text-sm text-slate">{item.variation}</p>
                          )
                        )}
                      </div>
                    </>
                  );
                  return (
                  <li key={item.id} className="px-4 py-3">
                    <div className="flex items-start gap-3">{content}</div>
                  </li>
                  );
                })}
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
              <SectionHeader
                title="Quick actions"
                description={`${hasDesigner ? "Reassign" : "Assign a designer"}, or send this order back for changes.`}
              />
              <div className="mt-4 flex flex-col gap-4">
                <OrderReassignForm
                  orderId={order.id}
                  assigned={hasDesigner}
                  designers={designers.map((designer) => ({
                    id: designer.id,
                    name: designer.name ?? designer.email,
                  }))}
                />
                <div className="border-t border-line pt-4">
                  <OrderRevisionForm
                    orderId={order.id}
                    initialNote={revisionStarter}
                    buttonLabel="Request revision"
                    disabled={!canCreateRevision}
                  />
                  {!canCreateRevision && (
                    <p className="mt-2 text-xs text-slate">
                      Revisions can start once an order is awaiting customer, approved, printing, shipped, delivered or complete.
                    </p>
                  )}
                </div>
              </div>
            </DataPanel>
          )}

          <DataPanel className="p-4">
            <SectionHeader
              title="Reference photos"
              actions={
                editable && references.length > 0 ? (
                  <Link
                    href={`/orders/${order.id}/complete`}
                    className="text-sm font-medium text-pigment hover:text-ink"
                  >
                    Manage
                  </Link>
                ) : undefined
              }
            />
            {references.length === 0 ? (
              <div className="mt-3 rounded-input border border-dashed border-line bg-canvas p-4 text-center">
                <Camera className="mx-auto text-slate" size={20} />
                <p className="mt-2 text-sm text-slate">No reference photos yet.</p>
                {editable && (
                  <Link
                    href={`/orders/${order.id}/complete`}
                    className="mt-3 inline-flex h-8 items-center gap-2 rounded-input bg-pigment px-3 text-sm font-medium text-surface transition-opacity hover:opacity-90"
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
            <SectionHeader title="Production &amp; tracking" />
            <dl className="mt-3 flex flex-col gap-3 text-sm">
              <Field
                label="Latest QC"
                value={latestQc ? `${titleCase(latestQc.result)} · ${fmtDateTime(latestQc.createdAt)}` : "No QC yet"}
                sub={latestQc?.reason ?? null}
              />
              <Field
                label="Print jobs"
                value={printRows.length ? `${printRows.length} print job(s)` : "No print job yet"}
              />
              {printRows.map((print, index) => (
                <div key={`${print.provider}-${print.createdAt.toISOString()}-${index}`} className="rounded-input bg-canvas p-2">
                  <p className="font-medium text-ink">{titleCase(print.provider)} · {titleCase(print.method)}</p>
                  <p className="text-xs text-slate">{print.status ?? "No provider status"} · {fmtDateTime(print.createdAt)}</p>
                  <p className="text-xs text-slate">
                    {print.trackingNumber
                      ? `Tracking ${print.trackingNumber}${print.trackingCompany ? ` · ${print.trackingCompany}` : ""}`
                      : "No tracking yet"}
                  </p>
                  {print.trackingUrl && (
                    <a href={print.trackingUrl} target="_blank" rel="noreferrer" className="text-xs font-medium text-pigment hover:text-ink">
                      Open tracking
                    </a>
                  )}
                </div>
              ))}
              {hasPhysicalItem && (
                <>
                  <Field
                    label="Current tracking"
                    value={latestTracking?.trackingNumber ?? "No tracking added yet"}
                    sub={latestTracking?.trackingCompany ?? null}
                  />
                  {latestTracking?.trackingUrl && (
                    <a
                      href={latestTracking.trackingUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="-mt-1.5 inline-flex text-xs font-medium text-pigment hover:text-ink"
                    >
                      Open tracking
                    </a>
                  )}
                  <Field
                    label="Provider"
                    value={
                      latestTracking
                        ? `${titleCase(latestTracking.provider)} · ${titleCase(latestTracking.method)}`
                        : "No print provider recorded"
                    }
                  />
                  <div>
                    <dt className="text-xs font-medium text-slate">Shopify writeback</dt>
                    <dd className="mt-0.5 text-slate">
                      {order.source !== "shopify"
                        ? "Not applicable for this order source."
                        : latestTracking?.shopifyFulfillmentId
                          ? `Fulfilled in Shopify · ${fmtDateTime(latestTracking.shopifySyncedAt)}`
                          : "No Shopify fulfillment created from AlphaOS yet."}
                    </dd>
                  </div>
                </>
              )}
            </dl>
            {hasPhysicalItem && editable && (
              <details className="group mt-3 rounded-input border border-line">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2.5 text-sm font-medium text-ink">
                  <span className="inline-flex items-center gap-2">
                    <Truck size={15} className="text-slate" />
                    Add / update tracking
                  </span>
                  <ChevronDown size={16} className="text-slate transition-transform group-open:rotate-180" />
                </summary>
                <div className="border-t border-line p-3">
                  <TrackingCompleteForm
                    orderId={order.id}
                    source={order.source}
                    disabled={order.status === "cancelled" || order.status === "on_hold"}
                  />
                </div>
              </details>
            )}
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

/** One tile in the at-a-glance summary strip. */
function Fact({
  icon: Icon,
  label,
  value,
  muted = false,
}: {
  icon: (props: IconProps) => React.ReactElement;
  label: string;
  value: string;
  muted?: boolean;
}) {
  return (
    <div className="bg-surface p-4">
      <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-slate">
        <Icon size={13} className="shrink-0" />
        {label}
      </div>
      <div
        className={cn("mt-1.5 truncate text-sm font-semibold", muted ? "text-slate" : "text-ink")}
        title={value}
      >
        {value}
      </div>
    </div>
  );
}

/** A label/value row inside a definition list (production & tracking panel). */
function Field({
  label,
  value,
  sub = null,
}: {
  label: string;
  value: React.ReactNode;
  sub?: string | null;
}) {
  return (
    <div>
      <dt className="text-xs font-medium text-slate">{label}</dt>
      <dd className="mt-0.5 break-words font-medium text-ink">{value}</dd>
      {sub && <p className="mt-1 text-sm text-slate">{sub}</p>}
    </div>
  );
}
