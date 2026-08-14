import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactElement } from "react";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { withUserContext } from "@/lib/db";
import { messages, orders } from "@/lib/db/schema";
import { liveOrderWhere } from "@/lib/orders/archive";
import { loadShellData } from "@/lib/shell/context";
import { Badge, DataPanel, Page, PageHeader } from "@/components/ui";
import { AlertTriangle, ArrowRight, CheckCircle, Inbox, Mail, Printer, User } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

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

type WorkItem = {
  label: string;
  count: number;
  href: string;
  detail: string;
  tone: "danger" | "warning" | "neutral" | "success";
  icon: (props: { size?: number; className?: string }) => ReactElement;
};

function dateOrNull(value: Date | string | null): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function overdueAge(now: Date, dueAt: Date | string | null): string {
  const due = dateOrNull(dueAt);
  if (!due) return "No due date";
  const hours = Math.max(0, (now.getTime() - due.getTime()) / 3_600_000);
  if (hours >= 48) {
    const days = Math.floor(hours / 24);
    return `Worst is ${days} day${days === 1 ? "" : "s"} overdue`;
  }
  const rounded = Math.round(hours * 10) / 10;
  return `Worst is ${rounded}h overdue`;
}

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const user = { id: session.user.id, role: session.user.role };
  if (user.role === "designer") redirect("/board");

  const { selected } = await loadShellData(user);
  const now = new Date();
  const counts = await withUserContext(user, async (tx) => {
    const businessFilter = eq(orders.businessId, selected.id);
    const liveFilter = liveOrderWhere();

    const [orderCounts] = await tx
      .select({
        awaitingQc: sql<number>`count(*) filter (where ${eq(orders.status, "awaiting_qc")})::int`,
        needsDetails: sql<number>`count(*) filter (where ${eq(orders.status, "awaiting_details")})::int`,
        overdue: sql<number>`count(*) filter (where ${inArray(orders.status, [...ACTIVE_STATES])} and ${orders.dueAt} is not null and ${orders.dueAt} < now())::int`,
        worstDueAt: sql<Date | string | null>`min(${orders.dueAt}) filter (where ${inArray(orders.status, [...ACTIVE_STATES])} and ${orders.dueAt} is not null and ${orders.dueAt} < now())`,
        awaitingCustomer: sql<number>`count(*) filter (where ${eq(orders.status, "awaiting_approval")})::int`,
        readyToPrint: sql<number>`count(*) filter (where ${eq(orders.status, "approved")} and exists (select 1 from order_items oi where oi.order_id = ${orders.id} and oi.product_type = 'physical'))::int`,
        unassigned: sql<number>`count(*) filter (where ${eq(orders.status, "ready_to_assign")} and not exists (select 1 from assignments a where a.order_id = ${orders.id} and a.active))::int`,
      })
      .from(orders)
      .where(and(businessFilter, liveFilter));

    const [emailCounts] = await tx
      .select({
        unmatched: sql<number>`count(*) filter (where ${eq(messages.direction, "inbound")} and ${messages.orderId} is null and ${messages.suppressedAt} is null)::int`,
        outboxAction: sql<number>`count(*) filter (where ${eq(messages.direction, "outbound")} and ${inArray(messages.status, ["draft", "failed"])})::int`,
      })
      .from(messages)
      .where(and(eq(messages.businessId, selected.id), isNull(messages.archivedAt)));

    return {
      awaitingQc: orderCounts?.awaitingQc ?? 0,
      needsDetails: orderCounts?.needsDetails ?? 0,
      overdue: orderCounts?.overdue ?? 0,
      worstDueAt: orderCounts?.worstDueAt ?? null,
      awaitingCustomer: orderCounts?.awaitingCustomer ?? 0,
      readyToPrint: orderCounts?.readyToPrint ?? 0,
      unassigned: orderCounts?.unassigned ?? 0,
      unmatched: emailCounts?.unmatched ?? 0,
      outboxAction: emailCounts?.outboxAction ?? 0,
    };
  });

  const emailTriage = counts.unmatched + counts.outboxAction;
  const work: WorkItem[] = [
    {
      label: "Awaiting QC",
      count: counts.awaitingQc,
      href: "/orders?view=awaiting_qc",
      detail: "Portraits ready for VA review",
      tone: counts.awaitingQc ? "warning" : "success",
      icon: CheckCircle,
    },
    {
      label: "Needs details",
      count: counts.needsDetails,
      href: "/orders?view=needs_details",
      detail: "Etsy orders waiting for VA completion",
      tone: counts.needsDetails ? "warning" : "success",
      icon: Inbox,
    },
    {
      label: "Overdue orders",
      count: counts.overdue,
      href: "/orders?view=overdue&sort=due&dir=asc",
      detail: counts.overdue ? overdueAge(now, counts.worstDueAt) : "No overdue work",
      tone: counts.overdue ? "danger" : "success",
      icon: AlertTriangle,
    },
    {
      label: "Awaiting customer",
      count: counts.awaitingCustomer,
      href: "/orders?view=awaiting_customer",
      detail: "Proofs waiting for customer approval or revisions",
      tone: counts.awaitingCustomer ? "warning" : "success",
      icon: Mail,
    },
    {
      label: "Ready to print",
      count: counts.readyToPrint,
      href: "/queue/print",
      detail: "Approved physical orders waiting for print",
      tone: counts.readyToPrint ? "warning" : "success",
      icon: Printer,
    },
    {
      label: "Email triage",
      count: emailTriage,
      href: "/emails",
      detail: `${counts.unmatched} unmatched replies, ${counts.outboxAction} outbox items`,
      tone: emailTriage ? "danger" : "success",
      icon: Mail,
    },
    {
      label: "Unassigned orders",
      count: counts.unassigned,
      href: "/orders?view=unassigned",
      detail: "Ready to assign with no active designer",
      tone: counts.unassigned ? "warning" : "success",
      icon: User,
    },
  ];

  return (
    <Page>
      <PageHeader
        title="Dashboard"
        description="What needs doing today for the selected business."
        eyebrow={selected.name}
        actions={
          <Link
            href="/orders"
            className="inline-flex h-10 items-center rounded-input bg-pigment px-3 text-sm font-medium text-surface transition-opacity hover:opacity-90"
          >
            View orders
          </Link>
        }
      />

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {work.map((item, index) => (
          <WorkCard key={item.label} item={item} priority={index + 1} />
        ))}
      </div>
    </Page>
  );
}

function WorkCard({ item, priority }: { item: WorkItem; priority: number }) {
  const Icon = item.icon;
  return (
    <Link href={item.href} className="group block">
      <DataPanel className={cn(
        "h-full p-5 transition-colors group-hover:bg-canvas",
        item.tone === "danger" && "border-rose/25",
        item.tone === "warning" && "border-amber/25",
        item.tone === "success" && "border-sage/20",
      )}>
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className={cn(
              "flex size-10 items-center justify-center rounded-input",
              item.tone === "danger" ? "bg-rose/10 text-rose" :
                item.tone === "warning" ? "bg-amber/10 text-amber" :
                  item.tone === "success" ? "bg-sage/10 text-sage" :
                    "bg-pigment-soft text-pigment",
            )}>
              <Icon size={18} />
            </span>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate">Priority {priority}</p>
              <h2 className="mt-1 text-base font-semibold text-ink">{item.label}</h2>
            </div>
          </div>
          <Badge variant={item.tone === "neutral" ? "neutral" : item.tone} dot={item.count > 0}>
            {item.count}
          </Badge>
        </div>
        <div className="mt-6 flex items-end justify-between gap-4">
          <div>
            <p className="text-5xl font-semibold leading-none text-ink">{item.count}</p>
            <p className="mt-2 text-sm leading-5 text-slate">{item.detail}</p>
          </div>
          <ArrowRight size={20} className="mb-1 shrink-0 text-slate transition-transform group-hover:translate-x-0.5 group-hover:text-pigment" />
        </div>
      </DataPanel>
    </Link>
  );
}
