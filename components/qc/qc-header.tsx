"use client";

import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";
import { Badge, Button, StatusChip } from "@/components/ui";
import type { OrderStatus } from "@/components/ui";
import type { QcContext } from "@/lib/qc/data";

/** Live elapsed time since the order entered QC. Amber after 2h. */
function TimeInQc({ since }: { since: string | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  if (!since) return <span className="text-xs text-slate">—</span>;
  const diff = Math.max(0, now - new Date(since).getTime());
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  const label = h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
  const overdue = h >= 2;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-chip px-2 py-1 text-xs font-medium tabular-nums",
        overdue ? "bg-amber/10 text-amber" : "bg-canvas text-slate",
      )}
    >
      <span
        className={cn("size-1.5 shrink-0 rounded-full", overdue ? "bg-amber" : "bg-slate/50")}
        aria-hidden="true"
      />
      in QC {label}
    </span>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] font-medium uppercase tracking-wide text-slate">{label}</span>
      <span className="text-sm font-medium text-ink">{children}</span>
    </div>
  );
}

export function QcHeader({
  ctx,
  position,
  total,
  hasPrev,
  hasNext,
  onPrev,
  onNext,
}: {
  ctx: QcContext;
  position: number; // 1-based, 0 if not in queue
  total: number;
  hasPrev: boolean;
  hasNext: boolean;
  onPrev: () => void;
  onNext: () => void;
}) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 rounded-card border border-line bg-surface px-4 py-3 shadow-sm">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        <div className="flex items-center gap-2.5 border-r border-line pr-5">
          <h1 className="font-display text-xl text-ink">{ctx.orderNumber}</h1>
          <StatusChip status={ctx.status as OrderStatus} />
        </div>
        <TimeInQc since={ctx.enteredQcAt} />
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-l border-line pl-5">
          <Fact label="Customer">{ctx.customerName}</Fact>
          <Fact label="Figures">
            {ctx.figuresResolved ? (
              ctx.figureCount
            ) : (
              <Badge variant="warning">unresolved</Badge>
            )}
          </Fact>
          <Fact label="Style">{ctx.style ?? "—"}</Fact>
          <Fact label="Designer">{ctx.designerName ?? "Unassigned"}</Fact>
        </div>
      </div>

      <div className="flex items-center gap-3">
        {position > 0 && total > 0 && (
          <span className="text-xs font-medium tabular-nums text-slate">
            {position} of {total} in queue
          </span>
        )}
        <div className="flex items-center gap-1 rounded-input border border-line bg-canvas p-1">
          <Button size="sm" variant="ghost" onClick={onPrev} disabled={!hasPrev}>
            ← Prev <kbd className="ml-1 rounded border border-line bg-surface px-1 text-[10px]">K</kbd>
          </Button>
          <Button size="sm" variant="ghost" onClick={onNext} disabled={!hasNext}>
            Next <kbd className="ml-1 rounded border border-line bg-surface px-1 text-[10px]">J</kbd> →
          </Button>
        </div>
      </div>
    </header>
  );
}
