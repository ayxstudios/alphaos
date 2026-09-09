import Link from "next/link";

import { Bars, HBars, Meter, StackedBar, fmtInt, fmtMoney } from "@/components/charts";
import { Mail, Truck } from "@/components/ui/icons";
import type { RequestUser } from "@/lib/db";
import { getStaffHome, type StaffHome } from "@/lib/home/staff";
import { pctDelta } from "@/lib/home/shared";
import { AttentionList } from "./attention-list";
import { DayLine, HomeSection, RowLabel, StatTile } from "./primitives";

/**
 * Admin and VA home. Same skeleton, different tiles: the owner leads with
 * the business (orders in, on time, overdue, designer pay); the VA leads
 * with their own day (needs you now, today, replies, QC). Everything below
 * the tiles is the same calm set of charts.
 */
export async function StaffHome({ user, businessId, role }: { user: RequestUser; businessId: string; role: "admin" | "va" }) {
  const h = await getStaffHome(user, businessId);
  return (
    <div className="flex flex-col gap-4 sm:gap-5">
      <DayLine>{daySentence(h)}</DayLine>
      {role === "admin" ? <AdminTiles h={h} /> : <VaTiles h={h} />}

      <div className="grid gap-4 sm:gap-5 lg:grid-cols-5">
        <HomeSection title="Do first" description={h.attention.counts.total ? `${h.attention.counts.now} need you now, ${h.attention.counts.today} today, ${h.attention.counts.soon} soon` : undefined} action={h.attention.counts.total ? { label: "Full queue", href: "/today" } : undefined} className="lg:col-span-3">
          <AttentionList items={h.attention.top} total={h.attention.counts.total} />
        </HomeSection>
        <HomeSection title="What is waiting" description="By kind, everything in the queue" className="lg:col-span-2">
          {h.attention.byKind.length === 0 ? (
            <p className="text-sm text-slate">Nothing waiting.</p>
          ) : (
            <HBars rows={h.attention.byKind.map((k) => ({ key: k.kind, label: k.label, value: k.n }))} color="c3" />
          )}
          <MailLine unmatched={h.messages.unmatched} failed={h.messages.failed} />
        </HomeSection>
      </div>

      <RowLabel>The bigger picture</RowLabel>
      <div className="grid gap-4 sm:gap-5 lg:grid-cols-2">
        <HomeSection quiet title="Orders in and shipped" description="Last 14 days" action={{ label: "Orders", href: "/orders" }}>
          <Bars
            series={[
              { name: "Orders in", color: "c1", values: h.ordersIn.values },
              { name: "Shipped", color: "c2", values: h.shipped.values },
            ]}
            labels={h.ordersIn.labels}
            height={190}
            ariaLabel="Orders placed and shipped per day, last 14 days"
          />
        </HomeSection>
        <HomeSection quiet title="Where every open order is" description={`${fmtInt(h.openOrders)} open orders by stage`} action={{ label: "Orders", href: "/orders" }}>
          <StackedBar segments={h.stages.map((s) => ({ key: s.key, label: s.label, value: s.n, color: s.color }))} height={22} ariaLabel="Open orders by stage" />
          <ShopRows shops={h.shops} />
        </HomeSection>
      </div>

      <div className="grid gap-4 sm:gap-5 lg:grid-cols-2">
        <HomeSection quiet title="Designer load" description="Work in flight against each limit" action={{ label: "Boards", href: "/board" }}>
          {h.designers.length === 0 ? (
            <p className="text-sm text-slate">No designers on the roster yet.</p>
          ) : (
            <div className="flex flex-col gap-3">
              {h.designers.slice(0, 6).map((d) => (
                <Meter
                  key={d.id}
                  label={d.name}
                  value={d.wip}
                  max={d.maxActive || Math.max(d.wip, d.dailyCapacity, 1)}
                  hint={d.assignedToday ? `${d.assignedToday} new today` : undefined}
                />
              ))}
            </div>
          )}
        </HomeSection>
        <HomeSection quiet title="Print" description="Print jobs, last 30 days" action={{ label: "Print queue", href: "/queue/print" }}>
          <StackedBar segments={h.print.map((p) => ({ key: p.label, label: p.label, value: p.n, color: p.color }))} height={22} emptyLabel="No print jobs yet" ariaLabel="Print jobs by state" />
          <div className="flex items-center gap-2 text-sm text-slate">
            <Truck size={16} />
            {h.shipped7d} shipped this week
          </div>
        </HomeSection>
      </div>
    </div>
  );
}

/** One plain sentence about the day: what needs a person, what is late, how shipping is going. */
function daySentence(h: StaffHome): string {
  const bits: string[] = [];
  const now = h.attention.counts.now;
  bits.push(now === 0 ? "Nothing is waiting on you right now" : `${fmtInt(now)} thing${now === 1 ? "" : "s"} need${now === 1 ? "s" : ""} a person today`);
  if (h.overdue > 0) bits.push(`${fmtInt(h.overdue)} order${h.overdue === 1 ? " is" : "s are"} overdue`);
  else if (h.dueToday > 0) bits.push(`${fmtInt(h.dueToday)} due today, none late`);
  else bits.push("nothing is late");
  if (h.onTimeRate30d !== null) bits.push(`${h.onTimeRate30d}% shipped on time this month`);
  return bits.join(", ") + ".";
}

function AdminTiles({ h }: { h: StaffHome }) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatTile
        label="Orders in"
        value={fmtInt(h.ordersIn7d)}
        delta={{ pct: pctDelta(h.ordersIn7d, h.ordersInPrev7d), good: "up", window: "vs previous 7 days", base: h.ordersInPrev7d, fallback: "Last 7 days" }}
        spark={{ points: h.ordersIn.values, labels: h.ordersIn.labels, color: "c1" }}
        href="/orders"
      />
      <StatTile
        label="On time"
        value={h.onTimeRate30d === null ? "No data" : `${h.onTimeRate30d}%`}
        hint={h.onTimeRate30d === null ? "Nothing shipped in 30 days" : "Shipped by the due date, 30 days"}
        tone={h.onTimeRate30d === null ? "neutral" : h.onTimeRate30d >= 90 ? "good" : h.onTimeRate30d >= 75 ? "warn" : "bad"}
        spark={{ points: h.shipped.values, labels: h.shipped.labels, color: "c2" }}
      />
      <StatTile
        label="Overdue"
        value={fmtInt(h.overdue)}
        hint={h.dueToday ? `${h.dueToday} more due today` : "Nothing else due today"}
        tone={h.overdue === 0 ? "good" : h.overdue < 5 ? "warn" : "bad"}
        href="/orders?view=overdue"
      />
      <StatTile
        label="Designer pay"
        value={fmtMoney(h.money?.designerPayMonth ?? 0)}
        hint={`${fmtMoney(h.money?.designerPayOwed ?? 0)} still to pay`}
        href="/payouts"
      />
    </div>
  );
}

function VaTiles({ h }: { h: StaffHome }) {
  const replies = h.attention.byKind.find((k) => k.kind === "reply")?.n ?? 0;
  const qc = h.attention.byKind.find((k) => k.kind === "qc")?.n ?? 0;
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatTile label="Needs you now" value={fmtInt(h.attention.counts.now)} hint="Someone is waiting" tone={h.attention.counts.now === 0 ? "good" : "bad"} href="/today" />
      <StatTile label="For today" value={fmtInt(h.attention.counts.today)} hint={`${h.attention.counts.soon} coming up soon`} tone={h.attention.counts.today === 0 ? "good" : "warn"} href="/today" />
      <StatTile label="Replies to send" value={fmtInt(replies)} hint={`${h.messages.unmatched} not matched to an order`} href="/emails" />
      <StatTile label="Overdue orders" value={fmtInt(h.overdue)} hint={qc ? `${qc} waiting for QC` : `${h.dueToday} due today`} tone={h.overdue === 0 ? "good" : "bad"} href="/orders?view=overdue" />
    </div>
  );
}

function MailLine({ unmatched, failed }: { unmatched: number; failed: number }) {
  const n = unmatched + failed;
  if (!n) return null;
  return (
    <Link href="/emails" className="flex items-center gap-2 rounded-input bg-canvas px-3 py-2 text-sm text-ink hover:bg-pigment-soft/60">
      <Mail size={16} className="text-pigment" />
      <span className="min-w-0 truncate">
        {unmatched ? `${unmatched} message${unmatched === 1 ? "" : "s"} not matched to an order` : ""}
        {unmatched && failed ? ", " : ""}
        {failed ? `${failed} failed send${failed === 1 ? "" : "s"}` : ""}
      </span>
    </Link>
  );
}

function ShopRows({ shops }: { shops: StaffHome["shops"] }) {
  if (shops.length < 2) return null;
  const max = Math.max(1, ...shops.map((s) => s.open));
  return (
    <ul className="flex flex-col gap-2 border-t border-line/70 pt-3">
      {shops.map((s) => (
        <li key={s.id} className="flex items-center gap-3 text-sm">
          <span className="w-24 shrink-0 truncate text-ink sm:w-36" title={s.name}>
            {s.name}
          </span>
          <span className="h-2 flex-1 overflow-hidden rounded-full" style={{ background: "var(--color-chart-track)" }}>
            <span className="block h-full rounded-full" style={{ width: `${Math.round((s.open / max) * 100)}%`, background: "var(--color-chart-1)" }} />
          </span>
          <span className="shrink-0 whitespace-nowrap text-right tabular-nums text-slate">
            <span className="text-ink">{s.open}</span> open{s.overdue ? <span className="text-rose">, {s.overdue} late</span> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}
