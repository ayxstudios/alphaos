"use client";

import Link from "next/link";
import { useEffect, useState, useTransition } from "react";

import { cn, styleLabel } from "@/lib/utils";
import { Avatar, Badge, DataPanel, EmptyState, useToast } from "@/components/ui";
import { focusRing } from "@/components/ui/styles";
import { Users } from "@/components/ui/icons";
import { setDailyLimit } from "@/app/(app)/designers/actions";
import type { DesignerLoad } from "@/lib/agent/capacity";
import type { RebalanceMove } from "@/lib/agent/rebalance";

const STATUS: Record<DesignerLoad["status"], { label: string; variant: "success" | "danger" | "warning" | "neutral" }> = {
  available: { label: "Available", variant: "success" },
  full: { label: "Full", variant: "warning" },
  over_capacity: { label: "Over capacity", variant: "danger" },
  quiet_hours: { label: "Quiet hours", variant: "warning" },
  deactivated: { label: "Deactivated", variant: "neutral" },
};

function LoadBar({ d }: { d: DesignerLoad }) {
  const pct = Math.min(100, d.utilisation * 100);
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span
          className={cn("tabular-nums", d.overCapacity ? "font-medium text-rose" : "text-ink")}
          title="Open orders against their limit (the tighter of the weekly limit and the most they may hold at once)"
        >
          {d.openLoad} of {d.limit} open
        </span>
        <span className="text-slate">{Math.round(d.utilisation * 100)}%</span>
      </div>
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-chart-track"
        role="progressbar"
        aria-label={`${d.name} load`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
      >
        <div className={cn("h-full rounded-full", d.overCapacity ? "bg-rose/70" : "bg-pigment/60")} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function CapacityInput({ d }: { d: DesignerLoad }) {
  const toast = useToast();
  const [value, setValue] = useState(String(d.dailyCapacity));
  const [saved, setSaved] = useState(d.dailyCapacity);
  const [, start] = useTransition();
  useEffect(() => {
    setValue(String(d.dailyCapacity));
    setSaved(d.dailyCapacity);
  }, [d.dailyCapacity]);

  function commit() {
    const n = parseInt(value, 10);
    if (!Number.isFinite(n) || n === saved) {
      setValue(String(saved));
      return;
    }
    const next = Math.max(0, n);
    const before = saved;
    setSaved(next);
    setValue(String(next));
    start(async () => {
      const res = await setDailyLimit(d.designerId, next);
      if (!res.ok) {
        setSaved(before);
        setValue(String(before));
        toast({ variant: "danger", title: "Update failed", description: res.message });
      } else {
        toast({ variant: "success", title: "Capacity saved", description: `${d.name}: ${next} a day, ${next * 5} a week.` });
      }
    });
  }

  return (
    <div className="flex items-center gap-2">
      <input
        type="number"
        min={0}
        inputMode="numeric"
        aria-label={`${d.name} orders per day`}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        className={cn("h-11 w-20 rounded-input border border-line bg-surface px-2.5 text-sm tabular-nums text-ink lg:h-9", focusRing)}
      />
      <span className="text-xs text-slate">a day, {saved * 5} a week</span>
    </div>
  );
}

function Styles({ styles }: { styles: string[] }) {
  if (!styles.length) return <span className="text-xs text-slate">No styles yet</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {styles.map((s) => (
        <span key={s} className="rounded bg-sage/10 px-1.5 py-0.5 text-xs text-sage">
          {styleLabel(s)}
        </span>
      ))}
    </div>
  );
}

function Status({ d }: { d: DesignerLoad }) {
  const s = STATUS[d.status];
  return (
    <div className="flex flex-col items-start gap-1">
      <Badge variant={s.variant} dot>{s.label}</Badge>
      <span className="text-xs text-slate">
        {d.daysToClear == null ? "No daily limit" : `${d.daysToClear} days to clear`}
        {d.queued > 0 ? `, ${d.queued} not started` : ""}
      </span>
    </div>
  );
}

export function CapacityTable({
  designers,
  suggestions,
  pinned,
  noTarget,
}: {
  designers: DesignerLoad[];
  suggestions: RebalanceMove[];
  pinned: number;
  noTarget: number;
}) {
  if (designers.length === 0) {
    return (
      <DataPanel>
        <EmptyState icon={Users} headline="No designers yet" body="Add a designer on the Designers page and their capacity shows here." />
      </DataPanel>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <ul className="flex flex-col gap-3 lg:hidden" aria-label="Designer capacity">
        {designers.map((d) => (
          <li key={d.designerId}>
            <DataPanel className="flex flex-col gap-3 p-4">
              <Link href={`/designers/${d.designerId}`} className={cn("flex min-h-11 items-center gap-2.5 rounded-input", focusRing)}>
                <Avatar name={d.name} size="sm" />
                <span className="min-w-0 truncate text-sm font-medium text-ink">{d.name}</span>
              </Link>
              <CapacityInput d={d} />
              <LoadBar d={d} />
              <Styles styles={d.styles} />
              <Status d={d} />
            </DataPanel>
          </li>
        ))}
      </ul>

      <div className="hidden overflow-hidden rounded-card bg-surface shadow-card lg:block">
        <table className="w-full text-left text-sm">
          <thead className="bg-surface text-xs text-slate shadow-[0_1px_0_0_var(--color-line)]">
            <tr>
              {["Designer", "Capacity", "Load", "Styles", "Status"].map((h) => (
                <th key={h} scope="col" className="px-4 py-2.5 font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line/70">
            {designers.map((d) => (
              <tr key={d.designerId} className="align-middle">
                <td className="px-4 py-3">
                  <Link href={`/designers/${d.designerId}`} className={cn("flex items-center gap-2.5 rounded-input", focusRing)}>
                    <Avatar name={d.name} size="sm" />
                    <span className="truncate font-medium text-ink hover:text-pigment">{d.name}</span>
                  </Link>
                </td>
                <td className="px-4 py-3"><CapacityInput d={d} /></td>
                <td className="w-56 px-4 py-3"><LoadBar d={d} /></td>
                <td className="px-4 py-3"><Styles styles={d.styles} /></td>
                <td className="px-4 py-3"><Status d={d} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <section aria-label="Agent rebalancing suggestions" className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold text-ink">Agent rebalancing</h2>
        {suggestions.length === 0 ? (
          <DataPanel className="p-4 text-sm text-slate">
            Nothing to move right now.
            {pinned > 0 ? ` ${pinned} ${pinned === 1 ? "order is" : "orders are"} pinned to a person, so the agent leaves them.` : ""}
            {noTarget > 0 ? ` ${noTarget} ${noTarget === 1 ? "order has" : "orders have"} nobody else who can take it.` : ""}
          </DataPanel>
        ) : (
          <DataPanel className="p-0">
            <ul className="divide-y divide-line/70">
              {suggestions.map((m) => (
                <li key={m.orderId} className="flex flex-col gap-1 px-4 py-3 text-sm">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <Link href={`/orders/${m.orderId}`} className="-my-2 inline-flex min-h-11 items-center font-medium text-pigment hover:underline lg:min-h-0 lg:py-0">
                      {m.orderNumber}
                    </Link>
                    <span className="text-ink">{m.fromName} to {m.toName}</span>
                  </div>
                  <p className="text-xs text-slate">{m.reason}</p>
                </li>
              ))}
            </ul>
          </DataPanel>
        )}
      </section>
    </div>
  );
}
