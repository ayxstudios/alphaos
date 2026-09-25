import Link from "next/link";

import { Bars, Meter, StackedBar, fmtInt, fmtMoney } from "@/components/charts";
import { focusRing } from "@/components/ui/styles";
import { ArrowRight, Calendar, Columns } from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import type { RequestUser } from "@/lib/db";
import { getDesignerHome } from "@/lib/home/designer";
import { DEFAULT_TIMEZONE } from "@/lib/designers/quiet-hours";
import { formatDeadline } from "@/lib/time";
import { pctDelta } from "@/lib/home/shared";
import { FoldSection } from "./fold-section";
import { DayLine, HomeSection, RowLabel, StatTile } from "./primitives";

/**
 * A designer's home: their own numbers only. What is due first, how the
 * board splits, figures delivered per day, this week's earnings.
 */
export async function DesignerHome({ user }: { user: RequestUser }) {
  const h = await getDesignerHome(user);
  const active = h.board.queue + h.board.inDesign + h.board.revisions + h.board.awaitingQc;
  const next = h.week.upcoming.slice(0, 5);
  // The designer's own zone (same as the board card and My Week), zone named.
  const tz = h.week.contact?.timezone || DEFAULT_TIMEZONE;
  const fmtDue = (iso: string | null) => formatDeadline(iso, tz, "No date");
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
          // A rolling 7 days (the chart below), not the calendar week the
          // earnings tile counts: named so the two never read as the same week.
          label="Figures, last 7 days"
          value={fmtInt(h.figures7d)}
          // Nothing the 7 days before to compare with: a plain word, no "new" pill.
          delta={
            h.figuresPrev7d > 0
              ? { pct: pctDelta(h.figures7d, h.figuresPrev7d), good: "up", window: "vs the 7 days before", base: h.figuresPrev7d, fallback: "Delivered" }
              : undefined
          }
          hint={h.figuresPrev7d > 0 ? undefined : "Delivered"}
          spark={{ points: h.figures.values, labels: h.figures.labels, color: "c2" }}
        />
        <StatTile label="Earned this week" value={fmtMoney(h.week.earningsThisWeek)} hint={`${fmtMoney(h.week.earningsThisMonth)} this month`} tone="good" href="/me" />
      </div>

      <div className="grid gap-4 sm:gap-5 lg:grid-cols-5">
        <HomeSection title="Due first" description="Your next deadlines" className="lg:col-span-3">
          {next.length === 0 ? (
            <p className="text-sm text-slate">No deadlines coming up.</p>
          ) : (
            <ul className="-mx-2 divide-y divide-line">
              {next.map((d) => {
                const due = d.dueAt ? new Date(d.dueAt) : null;
                const late = due ? due.getTime() < Date.now() : false;
                return (
                  <li key={d.orderId}>
                    {/* The whole row opens that card on the board. */}
                    <Link
                      href={`/board?open=${d.orderId}`}
                      className={cn("flex min-h-11 items-center gap-3 rounded-input px-2 py-2 text-sm hover:bg-canvas", focusRing)}
                    >
                      {/* Number over its deadline, so neither is cut short on a phone. */}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-semibold text-ink">{d.orderNumber}</span>
                        <span className={cn("block tabular-nums", late ? "text-rose" : "text-slate")}>{fmtDue(d.dueAt)}</span>
                      </span>
                      {late && <span className="shrink-0 rounded-chip bg-rose/10 px-2 py-0.5 text-xs font-medium text-rose">Late</span>}
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="flex flex-wrap gap-2">
            <Link href="/board" className={cn("inline-flex h-11 items-center gap-2 rounded-input bg-pigment px-4 text-sm font-medium text-surface hover:opacity-90 lg:h-10", focusRing)}>
              <Columns size={16} /> Open My Board
            </Link>
            <Link href="/me" className={cn("inline-flex h-11 items-center gap-2 rounded-input bg-canvas px-4 text-sm font-medium text-ink hover:bg-pigment-soft/60 lg:h-10", focusRing)}>
              <Calendar size={16} /> My Week <ArrowRight size={14} />
            </Link>
          </div>
        </HomeSection>
        {/* Phone: charts fold behind one line (FoldSection). */}
        <FoldSection
          id="my-board"
          title="My Board"
          description={`${active} order${active === 1 ? "" : "s"} in progress`}
          summary={
            [
              h.board.queue ? `${h.board.queue} queued` : null,
              h.board.inDesign ? `${h.board.inDesign} in design` : null,
              h.board.revisions ? `${h.board.revisions} in revision` : null,
              h.board.awaitingQc ? `${h.board.awaitingQc} in QC` : null,
            ]
              .filter(Boolean)
              .join(", ") || "Nothing on your board"
          }
          className="lg:col-span-2"
        >
          <StackedBar
            segments={[
              { key: "queue", label: "Queue", value: h.board.queue, color: "c3" },
              { key: "design", label: "In design", value: h.board.inDesign, color: "c1" },
              { key: "revisions", label: "Revisions", value: h.board.revisions, color: "c4" },
              { key: "qc", label: "Awaiting QC", value: h.board.awaitingQc, color: "c5" },
            ]}
            height={22}
            ariaLabel="My Board by column"
          />
          {h.board.withCustomer > 0 && (
            <p className="text-sm text-slate">
              {h.board.withCustomer} passed QC and {h.board.withCustomer === 1 ? "is" : "are"} with the customer.
            </p>
          )}
          {h.limits.maxActive > 0 && <Meter label="Active orders" value={active} max={h.limits.maxActive} />}
          {h.limits.dailyCapacity > 0 && <Meter label="Assigned today" value={h.assignedToday} max={h.limits.dailyCapacity} />}
        </FoldSection>
      </div>

      <RowLabel>The bigger picture</RowLabel>
      <FoldSection
        id="figures"
        quiet
        title="Figures delivered"
        description="Last 14 days"
        summary={`${fmtInt(h.figures.values.reduce((a, b) => a + b, 0))} figures in 14 days, ${h.week.ordersDoneThisWeek} order${h.week.ordersDoneThisWeek === 1 ? "" : "s"} done this week`}
        action={{ label: "My Week", href: "/me" }}
      >
        <Bars series={[{ name: "Figures", color: "c2", values: h.figures.values }]} labels={h.figures.labels} height={180} ariaLabel="Figures delivered per day" />
        <p className="text-sm text-slate">
          {h.week.ordersDoneThisWeek} order{h.week.ordersDoneThisWeek === 1 ? "" : "s"} done this week
          {h.week.onTimeRate !== null ? `, ${Math.round(h.week.onTimeRate * 100)}% on time` : ""}
          {h.week.revisionsThisWeek ? `, ${h.week.revisionsThisWeek} revision${h.week.revisionsThisWeek === 1 ? "" : "s"}` : ""}.
        </p>
      </FoldSection>
    </div>
  );
}
