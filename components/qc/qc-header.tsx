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
  return (
    <span className={cn("text-xs font-medium tabular-nums", h >= 2 ? "text-amber" : "text-slate")}>
      in QC {label}
    </span>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col">
      <span className="text-[11px] uppercase tracking-wide text-slate">{label}</span>
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
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <div className="flex items-center gap-3">
          <h1 className="font-display text-xl font-semibold text-ink">
            {ctx.orderNumber}
          </h1>
          <StatusChip status={ctx.status as OrderStatus} />
          <TimeInQc since={ctx.enteredQcAt} />
        </div>
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

      <div className="flex items-center gap-2">
        {position > 0 && total > 0 && (
          <span className="text-xs tabular-nums text-slate">
            {position} of {total} in queue
          </span>
        )}
        <Button size="sm" variant="secondary" onClick={onPrev} disabled={!hasPrev}>
          ← Prev <kbd className="ml-1 rounded border border-line bg-canvas px-1 text-[10px]">K</kbd>
        </Button>
        <Button size="sm" variant="secondary" onClick={onNext} disabled={!hasNext}>
          Next <kbd className="ml-1 rounded border border-line bg-canvas px-1 text-[10px]">J</kbd> →
        </Button>
      </div>
    </header>
  );
}
