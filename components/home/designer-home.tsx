import Link from "next/link";

import { Bars, Meter, StackedBar, fmtInt, fmtMoney } from "@/components/charts";
import { focusRing } from "@/components/ui/styles";
import { ArrowRight, Calendar, Columns } from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import type { RequestUser } from "@/lib/db";
import { getDesignerHome } from "@/lib/home/designer";
import { pctDelta } from "@/lib/home/shared";
import { DayLine, HomeSection, RowLabel, StatTile } from "./primitives";

/**
 * A designer's home: their own numbers only. What is due first, how the
 * board splits, figures delivered per day, this week's earnings.
 */
export async function DesignerHome({ user }: { user: RequestUser }) {
  const h = await getDesignerHome(user);
  const active = h.board.queue + h.board.inDesign + h.board.revisions + h.board.awaitingQc;
  const next = h.week.upcoming.slice(0, 5);
  const tz = h.week.contact?.timezone || "Australia/Melbourne";
  const fmtDue = (iso: string | null) =>
    iso ? new Intl.DateTimeFormat("en-AU", { timeZone: tz, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date(iso)).replace(",", "") : "No date";
  const sentence = [
    h.overdue ? `${h.overdue} order${h.overdue === 1 ? " is" : "s are"} late` : h.dueToday ? `${h.dueToday} due today` : "Nothing due today",
    `${active} on your board`,
    `${fmtMoney(h.week.earningsThisWeek)} earned this week`,
  ].join(", ") + ".";
  return (
    <div className="flex flex-col gap-4 sm:gap-5">
      <DayLine>{sentence}</DayLine>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Due today" value={fmtInt(h.dueToday)} hint={h.overdue ? `${h.overdue} already late` : "Nothing late"} tone={h.overdue ? "bad" : h.dueToday ? "warn" : "good"} href="/board" />
        <StatTile label="In my queue" value={fmtInt(h.board.queue)} hint={`${h.board.inDesign + h.board.revisions} in design`} href="/board" />
        <StatTile
          label="Figures this week"
          value={fmtInt(h.figures7d)}
          delta={{ pct: pctDelta(h.figures7d, h.figuresPrev7d), good: "up", window: "vs last week", base: h.figuresPrev7d, fallback: "Last 7 days" }}
          spark={{ points: h.figures.values, labels: h.figures.labels, color: "c2" }}
        />
        <StatTile label="Earned this week" value={fmtMoney(h.week.earningsThisWeek)} hint={`${fmtMoney(h.week.earningsThisMonth)} this month`} tone="good" href="/me" />
      </div>

      <div className="grid gap-4 sm:gap-5 lg:grid-cols-5">
        <HomeSection title="Due first" description="Your next deadlines" action={{ label: "My board", href: "/board" }} className="lg:col-span-3">
          {next.length === 0 ? (
            <p className="text-sm text-slate">No deadlines coming up.</p>
          ) : (
            <ul className="divide-y divide-line">
              {next.map((d) => {
                const due = d.dueAt ? new Date(d.dueAt) : null;
                const late = due ? due.getTime() < Date.now() : false;
                return (
                  <li key={d.orderId} className="flex items-center gap-3 py-2.5 text-sm">
                    <span className={cn("hidden w-20 shrink-0 rounded-chip px-2 py-0.5 text-center text-xs font-medium sm:block", late ? "bg-rose/10 text-rose" : "bg-pigment-soft text-pigment")}>{late ? "Late" : "Due"}</span>
                    <Link href={`/orders/${d.orderId}`} className={cn("min-w-0 flex-1 truncate font-semibold text-ink hover:text-pigment", focusRing)}>
                      {d.orderNumber}
                    </Link>
                    <span className={cn("shrink-0 whitespace-nowrap tabular-nums", late ? "text-rose" : "text-slate")}>{fmtDue(d.dueAt)}</span>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="flex flex-wrap gap-2">
            <Link href="/board" className={cn("inline-flex h-10 items-center gap-2 rounded-input bg-pigment px-4 text-sm font-medium text-surface hover:opacity-90", focusRing)}>
              <Columns size={16} /> Open my board
            </Link>
            <Link href="/me" className={cn("inline-flex h-10 items-center gap-2 rounded-input bg-canvas px-4 text-sm font-medium text-ink hover:bg-pigment-soft/60", focusRing)}>
              <Calendar size={16} /> My week <ArrowRight size={14} />
            </Link>
          </div>
        </HomeSection>
        <HomeSection title="My board" description={`${active} live orders`} className="lg:col-span-2">
          <StackedBar
            segments={[
              { key: "queue", label: "Queue", value: h.board.queue, color: "c3" },
              { key: "design", label: "In design", value: h.board.inDesign, color: "c1" },
              { key: "revisions", label: "Revisions", value: h.board.revisions, color: "c4" },
              { key: "qc", label: "Awaiting QC", value: h.board.awaitingQc, color: "c5" },
            ]}
            height={22}
            ariaLabel="My board by column"
          />
          {h.limits.maxActive > 0 && <Meter label="Active orders" value={active} max={h.limits.maxActive} />}
          {h.limits.dailyCapacity > 0 && <Meter label="Assigned today" value={h.assignedToday} max={h.limits.dailyCapacity} />}
        </HomeSection>
      </div>

      <RowLabel>The bigger picture</RowLabel>
      <HomeSection quiet title="Figures delivered" description="Last 14 days" action={{ label: "My week", href: "/me" }}>
        <Bars series={[{ name: "Figures", color: "c2", values: h.figures.values }]} labels={h.figures.labels} height={180} ariaLabel="Figures delivered per day" />
        <p className="text-sm text-slate">
          {h.week.ordersDoneThisWeek} order{h.week.ordersDoneThisWeek === 1 ? "" : "s"} done this week
          {h.week.onTimeRate !== null ? `, ${Math.round(h.week.onTimeRate * 100)}% on time` : ""}
          {h.week.revisionsThisWeek ? `, ${h.week.revisionsThisWeek} revision${h.week.revisionsThisWeek === 1 ? "" : "s"}` : ""}.
        </p>
      </HomeSection>
    </div>
  );
}
