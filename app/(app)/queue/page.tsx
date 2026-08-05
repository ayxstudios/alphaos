import { redirect } from "next/navigation";
import Link from "next/link";

import { auth } from "@/lib/auth";
import { loadShellData } from "@/lib/shell/context";
import {
  getVaQueue,
  VA_TABS,
  VA_TAB_LABELS,
  type VaTab,
} from "@/lib/orders/board-data";
import { staffTransitionsFrom, type OrderStatus } from "@/lib/orders/transitions";
import { getOutboxCount } from "@/lib/email/outbox";
import { QueueCard } from "@/components/board/queue-card";
import { EmptyState, FilterBar, Page, PageHeader } from "@/components/ui";
import { ListChecks, Plus } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

const ACTION_LABEL: Partial<Record<OrderStatus, string>> = {
  awaiting_photos: "Needs photos",
  ready_to_assign: "Ready to assign",
  in_design: "Send back",
  awaiting_qc: "Send to QC",
  awaiting_approval: "Pass QC",
  approved: "Approve",
  printing: "Start printing",
  shipped: "Mark shipped",
  delivered: "Mark delivered",
  complete: "Mark complete",
  fulfillment_only: "Fulfil only",
};

export default async function QueuePage({
  searchParams,
}: {
  searchParams: Promise<{ [k: string]: string | string[] | undefined }>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const user = { id: session.user.id, role: session.user.role };
  if (user.role === "designer") redirect("/board");

  const sp = await searchParams;
  const tab: VaTab =
    typeof sp.tab === "string" && (VA_TABS as readonly string[]).includes(sp.tab)
      ? (sp.tab as VaTab)
      : "needs_photos";

  const { selected } = await loadShellData(user);
  const { cards, counts } = await getVaQueue(user, {
    businessId: selected.id,
    tab,
  });
  const outboxCount = await getOutboxCount(user, { businessId: selected.id });

  return (
    <Page className="max-w-none">
      <PageHeader
        title="Queue"
        description="Prioritized VA work for the selected workspace."
        actions={
          <>
            <Link
              href="/queue/outbox"
              className="inline-flex h-10 items-center rounded-input px-3 text-sm font-medium text-pigment transition-colors hover:bg-pigment-soft"
            >
              Outbox{outboxCount > 0 ? ` (${outboxCount})` : ""}
            </Link>
            <Link
              href="/queue/review"
              className="inline-flex h-10 items-center rounded-input px-3 text-sm font-medium text-pigment transition-colors hover:bg-pigment-soft"
            >
              Review queue
            </Link>
            <Link
              href="/orders/new"
              className="inline-flex h-10 items-center gap-2 rounded-input bg-pigment px-3 text-sm font-medium text-surface transition-opacity hover:opacity-90"
            >
              <Plus size={16} />
              New order
            </Link>
          </>
        }
      />

      <FilterBar className="gap-1">
        {VA_TABS.map((t) => {
          const active = t === tab;
          return (
            <Link
              key={t}
              href={`/queue?tab=${t}`}
              className={cn(
                "inline-flex h-9 items-center gap-2 rounded-input px-3 text-sm font-medium transition-colors motion-hover",
                active
                  ? "bg-pigment text-surface"
                  : "text-slate hover:bg-canvas hover:text-ink",
              )}
            >
              {VA_TAB_LABELS[t]}
              <span
                className={cn(
                  "rounded-full px-1.5 text-xs",
                  active ? "bg-surface/20" : "bg-canvas text-slate",
                )}
              >
                {counts[t]}
              </span>
            </Link>
          );
        })}
      </FilterBar>

      {cards.length === 0 ? (
        <div className="rounded-card border border-line bg-surface shadow-sm">
          <EmptyState
            icon={ListChecks}
            headline="Nothing here"
            body={`No orders in ${VA_TAB_LABELS[tab]}.`}
          />
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {cards.map((c) => (
            <QueueCard
              key={c.orderId}
              card={c}
              qcHref={c.status === "awaiting_qc" ? `/qc/${c.orderId}` : undefined}
              completeHref={
                c.status === "awaiting_details"
                  ? `/orders/${c.orderId}/complete`
                  : undefined
              }
              actions={
                c.status === "awaiting_qc" || c.status === "awaiting_details"
                  ? []
                  : c.status === "triage"
                    ? [
                        {
                          to: (c.thumbnailUrl
                            ? "ready_to_assign"
                            : "awaiting_photos") as OrderStatus,
                          label: "Portrait",
                        },
                        { to: "fulfillment_only" as OrderStatus, label: "Fulfil only" },
                        { to: "complete" as OrderStatus, label: "Close" },
                      ]
                    : staffTransitionsFrom(c.status)
                        .filter((to) => to !== "on_hold" && to !== "cancelled")
                        .map((to) => ({ to, label: ACTION_LABEL[to] ?? to }))
              }
            />
          ))}
        </div>
      )}
    </Page>
  );
}
