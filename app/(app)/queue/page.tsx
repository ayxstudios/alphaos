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
import { Card, EmptyState } from "@/components/ui";
import { ListChecks } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

// Human labels for the quick-advance buttons, keyed by target status.
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
  const { cards, counts } = await getVaQueue(user, { businessId: selected.id, tab });
  const outboxCount = await getOutboxCount(user, { businessId: selected.id });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="font-display text-2xl font-semibold text-ink">Queue</h1>
        <div className="flex items-center gap-4">
          <Link href="/queue/outbox" className="text-sm font-medium text-pigment hover:underline">
            Outbox{outboxCount > 0 ? ` (${outboxCount})` : ""} →
          </Link>
          <Link href="/queue/review" className="text-sm font-medium text-pigment hover:underline">
            Review queue →
          </Link>
          <Link
            href="/orders/new"
            className="inline-flex h-9 items-center rounded-input bg-pigment px-3 text-sm font-medium text-surface hover:opacity-90"
          >
            + New order
          </Link>
        </div>
      </div>

      <div className="flex flex-wrap gap-1 border-b border-line pb-2">
        {VA_TABS.map((t) => (
          <Link
            key={t}
            href={`/queue?tab=${t}`}
            className={cn(
              "rounded-input px-3 py-1.5 text-sm transition-colors motion-hover",
              t === tab ? "bg-pigment-soft font-medium text-pigment" : "text-slate hover:bg-canvas",
            )}
          >
            {VA_TAB_LABELS[t]} <span className="text-xs text-slate">({counts[t]})</span>
          </Link>
        ))}
      </div>

      {cards.length === 0 ? (
        <Card>
          <EmptyState icon={ListChecks} headline="Nothing here" body={`No orders in ${VA_TAB_LABELS[tab]}.`} />
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {cards.map((c) => (
            <QueueCard
              key={c.orderId}
              card={c}
              // Awaiting-QC orders go through the checklist gate, never a one-click pass.
              qcHref={c.status === "awaiting_qc" ? `/qc/${c.orderId}` : undefined}
              // Etsy needs-details orders open the manual completion form.
              completeHref={c.status === "awaiting_details" ? `/orders/${c.orderId}/complete` : undefined}
              actions={
                c.status === "awaiting_qc" || c.status === "awaiting_details"
                  ? []
                  : c.status === "triage"
                    ? // One click either way — never guess (photos present => straight to assign).
                      [
                        { to: (c.thumbnailUrl ? "ready_to_assign" : "awaiting_photos") as OrderStatus, label: "Portrait" },
                        { to: "fulfillment_only" as OrderStatus, label: "Fulfil only" },
                        { to: "complete" as OrderStatus, label: "Close (billing)" },
                      ]
                    : staffTransitionsFrom(c.status)
                        .filter((to) => to !== "on_hold" && to !== "cancelled")
                        .map((to) => ({ to, label: ACTION_LABEL[to] ?? to }))
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}
