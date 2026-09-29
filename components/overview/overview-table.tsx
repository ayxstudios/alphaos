"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { Badge, DataPanel, EmptyState, Select } from "@/components/ui";
import { Package } from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import { QuickReassign } from "@/components/orders/quick-reassign";
import { aiStateLabel } from "@/lib/agent/ai-frameworks";
import type { OverviewRow } from "@/lib/agent/overview";

function duration(ms: number): string {
  const total = Math.max(ms, 0);
  const days = Math.floor(total / 86_400_000);
  const hours = Math.floor((total % 86_400_000) / 3_600_000);
  const mins = Math.floor((total % 3_600_000) / 60_000);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  return `${mins}m`;
}

function AiBadge({ state }: { state: string }) {
  return (
    <Badge variant="info" className="ml-2" data-testid="ai-made-badge">
      AI made this: {aiStateLabel(state)}
    </Badge>
  );
}

function TimeCell({ row }: { row: OverviewRow }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="tabular-nums text-ink">
        {duration(row.timeInStageMs)}
        {row.targetMs != null && <span className="text-slate"> / {duration(row.targetMs)}</span>}
      </span>
      {row.delayed && <Badge variant="danger">Delayed</Badge>}
    </span>
  );
}

const chip = "inline-flex min-h-11 items-center rounded-chip border px-3 text-sm font-medium lg:min-h-9";

export function OverviewTable({
  rows,
  businesses,
  stages,
}: {
  rows: OverviewRow[];
  businesses: { id: string; name: string }[];
  stages: { value: string; label: string }[];
}) {
  const [biz, setBiz] = useState<string>("");
  const [stage, setStage] = useState("");
  const [delayedOnly, setDelayedOnly] = useState(false);
  const [q, setQ] = useState("");

  const shown = useMemo(() => {
    const term = q.trim().replace(/^#/, "").toLowerCase();
    return rows.filter(
      (r) =>
        (!biz || r.businessId === biz) &&
        (!stage || r.status === stage) &&
        (!delayedOnly || r.delayed) &&
        (!term || r.orderNumber.replace(/^#/, "").toLowerCase().includes(term)),
    );
  }, [rows, biz, stage, delayedOnly, q]);

  const delayedCount = rows.filter((r) => r.delayed).length;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-3 rounded-card bg-surface p-3 shadow-card lg:flex-row lg:items-end">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Business">
          <button type="button" onClick={() => setBiz("")} aria-pressed={!biz}
            className={cn(chip, !biz ? "border-pigment/30 bg-pigment-soft text-pigment" : "border-line text-slate")}>
            All businesses
          </button>
          {businesses.map((b) => (
            <button key={b.id} type="button" onClick={() => setBiz(biz === b.id ? "" : b.id)} aria-pressed={biz === b.id}
              className={cn(chip, biz === b.id ? "border-pigment/30 bg-pigment-soft text-pigment" : "border-line text-slate")}>
              {b.name}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-3 lg:ml-auto lg:flex lg:items-end">
          <Select label="Stage" value={stage} onChange={(e) => setStage(e.target.value)} className="lg:w-48">
            <option value="">All stages</option>
            {stages.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </Select>
          <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
            Order number
            <input
              type="search"
              inputMode="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search"
              className="h-11 rounded-input border border-line bg-surface px-3 text-sm font-normal text-ink lg:h-10 lg:w-44"
            />
          </label>
          <button type="button" onClick={() => setDelayedOnly((v) => !v)} aria-pressed={delayedOnly}
            className={cn(chip, "col-span-2 min-h-11 justify-center lg:min-h-10", delayedOnly ? "border-rose/30 bg-rose/10 text-rose" : "border-line text-slate")}>
            Delayed only{delayedCount ? ` (${delayedCount})` : ""}
          </button>
        </div>
      </div>

      {shown.length === 0 ? (
        <DataPanel>
          <EmptyState icon={Package} headline="No orders match." body="Clear a filter to see more." />
        </DataPanel>
      ) : (
        <>
          <p className="text-xs text-slate">{shown.length} open {shown.length === 1 ? "order" : "orders"}</p>

          <ul className="flex flex-col gap-3 lg:hidden">
            {shown.map((r) => (
              <li key={r.id}>
                <DataPanel className="flex flex-col gap-2 p-4">
                  <div className="flex items-center justify-between gap-2">
                    <Link href={`/orders/${r.id}`} className="-my-2 inline-flex min-h-11 items-center font-medium text-pigment hover:underline">
                      {r.orderNumber}
                    </Link>
                    <span className="min-w-0 truncate text-sm text-slate">{r.businessName}</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className={cn("font-medium", r.revisionCount > 0 ? "text-amber" : "text-ink")}>{r.stage}</span>
                    {r.aiState && <AiBadge state={r.aiState} />}
                    <TimeCell row={r} />
                  </div>
                  <dl className="grid grid-cols-2 gap-2 text-sm">
                    <div><dt className="text-xs text-slate">Designer</dt><dd className="break-words text-ink">{r.designer ?? "Unassigned"}</dd></div>
                    <div><dt className="text-xs text-slate">Next</dt><dd className="text-ink">{r.nextActor}</dd></div>
                  </dl>
                  <QuickReassign orderId={r.id} className="self-start -ml-2" />
                </DataPanel>
              </li>
            ))}
          </ul>

          <div className="hidden overflow-hidden rounded-card bg-surface shadow-card lg:block">
            <div className="max-h-[70vh] overflow-auto">
              <table className="w-full text-left text-sm">
                <thead className="sticky top-0 z-10 bg-surface text-xs text-slate shadow-[0_1px_0_0_var(--color-line)]">
                  <tr>
                    {["Order", "Business", "Stage", "Time in stage / target", "Designer", "Next", ""].map((h) => (
                      <th key={h} scope="col" className="px-4 py-2.5 font-medium">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-line/70">
                  {shown.map((r) => (
                    <tr key={r.id} className="hover:bg-slate/5">
                      <td className="px-4 py-2.5">
                        <Link href={`/orders/${r.id}`} className="font-medium text-pigment hover:underline">{r.orderNumber}</Link>
                      </td>
                      <td className="px-4 py-2.5 text-slate">{r.businessName}</td>
                      <td className={cn("px-4 py-2.5", r.revisionCount > 0 ? "font-medium text-amber" : "text-ink")}>
                        <span>{r.stage}</span>
                        {r.aiState && <AiBadge state={r.aiState} />}
                      </td>
                      <td className="px-4 py-2.5"><TimeCell row={r} /></td>
                      <td className="px-4 py-2.5 text-ink">{r.designer ?? "Unassigned"}</td>
                      <td className="px-4 py-2.5 text-ink">{r.nextActor}</td>
                      <td className="px-4 py-1 text-right"><QuickReassign orderId={r.id} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
