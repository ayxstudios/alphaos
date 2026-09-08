import { DataPanel, EmptyState, StatCard } from "@/components/ui";
import { Calendar } from "@/components/ui/icons";
import { Countdown } from "@/components/board/countdown";
import { stateLabel } from "@/components/board/card-meta";
import type { OrderStatus } from "@/lib/orders/transitions";
import type { DesignerWeek } from "@/lib/designers/my-week";

function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

function pct(n: number | null): string {
  return n == null ? "—" : `${Math.round(n * 100)}%`;
}

/**
 * "My week" — phone-first, one column, big numbers. Shared by /me (a designer
 * looking at themselves) and /designers/[id] (staff looking at one designer).
 */
export function DesignerWeekView({ week }: { week: DesignerWeek }) {
  const c = week.contact;
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
          <p className="text-xs text-slate">Week starting {week.weekStartLabel} · {week.activeOrders} order{week.activeOrders === 1 ? "" : "s"} in flight</p>
        </div>
        {week.upcoming.length === 0 ? (
          <EmptyState icon={Calendar} headline="Nothing on deck" body="No active orders right now." />
        ) : (
          <ul className="divide-y divide-line">
            {week.upcoming.map((u) => (
              <li key={u.orderId} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-ink">{u.orderNumber}</p>
                  <p className="text-xs text-slate">
                    {stateLabel(u.status as OrderStatus)}
                    {u.dueAtLocal ? ` · due ${u.dueAtLocal}` : ""}
                  </p>
                </div>
                <Countdown dueAt={u.dueAt} />
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
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate">Phone</p>
            <p className="text-ink">{c?.phone ?? "Not set"}</p>
          </div>
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate">Channel</p>
            <p className="capitalize text-ink">{c?.preferredChannel ?? "whatsapp"}</p>
          </div>
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate">Timezone</p>
            <p className="text-ink">{c?.timezoneRaw ?? "Not set"}</p>
          </div>
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate">Quiet hours</p>
            <p className="text-ink">{c?.quietStart && c?.quietEnd ? `${c.quietStart}–${c.quietEnd}` : "None"}</p>
          </div>
        </div>
        <p className="border-t border-line px-4 py-2.5 text-xs text-slate">
          An admin or VA sets these on the Designers page.
        </p>
      </DataPanel>
    </div>
  );
}
