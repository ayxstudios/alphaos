import Link from "next/link";

import { DataPanel, EmptyState, StatCard } from "@/components/ui";
import { focusRing } from "@/components/ui/styles";
import { Calendar } from "@/components/ui/icons";
import { Countdown } from "@/components/board/countdown";
import { designerStateLabel } from "@/components/board/card-meta";
import { cn } from "@/lib/utils";
import type { OrderStatus } from "@/lib/orders/transitions";
import type { DesignerWeek } from "@/lib/designers/my-week";

function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

/** Contact channels by their proper names ("WhatsApp", not "Whatsapp"). */
const CHANNEL: Record<string, string> = { whatsapp: "WhatsApp", email: "Email", sms: "SMS", telegram: "Telegram" };

function pct(n: number | null): string {
  return n == null ? "-" : `${Math.round(n * 100)}%`;
}

/**
 * "My week" — phone-first, one column, big numbers. Shared by /me (a designer
 * looking at themselves) and /designers/[id] (staff looking at one designer).
 */
export function DesignerWeekView({ week, self = false }: { week: DesignerWeek; self?: boolean }) {
  const c = week.contact;
  // A deadline row opens that card on the board: the designer's own board, or
  // (staff) this designer's.
  const cardHref = (orderId: string) =>
    self ? `/board?open=${orderId}` : `/board?designer=${week.designerId}&open=${orderId}`;
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3">
        <StatCard label="Earned this week" value={money(week.earningsThisWeek)} tone="success" />
        <StatCard label="Earned today" value={money(week.earningsToday)} tone="info" />
        <StatCard label="Orders done this week" value={week.ordersDoneThisWeek} />
        <StatCard label="On-time this week" value={pct(week.onTimeRate)} tone={week.onTimeRate != null && week.onTimeRate < 0.8 ? "warning" : "neutral"} />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <StatCard label="Revisions this week" value={week.revisionsThisWeek} tone={week.revisionsThisWeek > 0 ? "warning" : "neutral"} />
        <StatCard label="Earned this month" value={money(week.earningsThisMonth)} />
      </div>

      <DataPanel>
        <div className="border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold text-ink">Next deadlines</h2>
          <p className="text-xs text-slate">
            Week of {week.weekStartLabel} · {week.activeOrders} in progress
            {week.withCustomer > 0 ? ` · ${week.withCustomer} with the customer` : ""}
          </p>
        </div>
        {week.upcoming.length === 0 ? (
          <EmptyState icon={Calendar} headline="Nothing due" body="No orders in progress right now." />
        ) : (
          <ul className="divide-y divide-line">
            {week.upcoming.map((u) => (
              <li key={u.orderId}>
                <Link
                  href={cardHref(u.orderId)}
                  className={cn("flex min-h-11 items-center justify-between gap-3 px-4 py-3 hover:bg-canvas/60", focusRing)}
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-ink">{u.orderNumber}</p>
                    <p className="text-xs text-slate">
                      {/* A queued card is assigned and waiting on the designer to
                          start it: "Ready to assign" is the staff-side name. */}
                      {designerStateLabel(u.status as OrderStatus)}
                      {u.dueAtLocal ? ` · due ${u.dueAtLocal}` : ""}
                    </p>
                  </div>
                  <span className="shrink-0 whitespace-nowrap">
                    <Countdown dueAt={u.dueAt} />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </DataPanel>

      <DataPanel>
        <div className="border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold text-ink">Contact &amp; quiet hours</h2>
        </div>
        <div className="grid grid-cols-2 gap-3 p-4 text-sm sm:grid-cols-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-slate">Phone</p>
            <p className="text-ink">{c?.phone ?? "Not set"}</p>
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-slate">Channel</p>
            <p className="text-ink">{CHANNEL[c?.preferredChannel ?? "whatsapp"] ?? c?.preferredChannel}</p>
          </div>
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate">Timezone</p>
            {/* Underscores out ("Asia/Kuala Lumpur"); an unset zone says it is the default. */}
            <p className="break-words text-ink">
              {(c?.timezoneRaw ?? c?.timezone ?? "Not set").replace(/_/g, " ")}
              {c && !c.timezoneRaw ? <span className="text-slate"> (default)</span> : null}
            </p>
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-slate">Quiet hours</p>
            <p className="text-ink">{c?.quietStart && c?.quietEnd ? `${c.quietStart} to ${c.quietEnd}` : "None"}</p>
          </div>
        </div>
        <p className="border-t border-line px-4 py-2.5 text-xs text-slate">
          {self ? "Need a change? Ask your VA or admin." : "An admin or VA sets these on the Designers page."}
        </p>
      </DataPanel>
    </div>
  );
}
