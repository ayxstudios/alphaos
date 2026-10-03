"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { cn, styleLabel } from "@/lib/utils";
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

  if (!since) return null;
  const diff = Math.max(0, now - new Date(since).getTime());
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  const label = h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
  return (
    <span className={cn("text-xs font-medium tabular-nums", h >= 2 ? "text-amber" : "text-slate")}>
      waiting {label}
    </span>
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
  const firstName = ctx.customerName.split(" ")[0];
  return (
    <header className="flex flex-col gap-2 rounded-card bg-surface px-4 py-3 shadow-card">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <Link
            href="/qc"
            className="inline-flex min-h-11 items-center rounded-input pr-1 text-sm font-medium text-pigment hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pigment"
          >
            ← Awaiting QC
          </Link>
          <h1 className="font-display text-xl font-semibold text-ink">
            <Link
              href={`/orders/${ctx.orderId}`}
              target="_blank"
              rel="noreferrer"
              className="rounded-input underline-offset-4 max-sm:inline-flex max-sm:min-h-11 max-sm:items-center hover:text-pigment hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pigment"
              aria-label={`Open order ${ctx.orderNumber} in a new tab`}
              title="Open the order in a new tab"
            >
              {ctx.orderNumber}
            </Link>
            {firstName && firstName !== "-" && <span className="font-normal text-slate"> · {firstName}</span>}
          </h1>
          {ctx.status !== "awaiting_qc" && <StatusChip status={ctx.status as OrderStatus} />}
          {/* Only a live QC clock: a passed or finished order is not "in QC". */}
          {ctx.status === "awaiting_qc" && <TimeInQc since={ctx.enteredQcAt} />}
        </div>

        <div className="flex items-center gap-2">
          {position > 0 && total > 0 && (
            <span className="text-xs tabular-nums text-slate">
              {position} of {total}
            </span>
          )}
          <Button size="sm" variant="secondary" onClick={onPrev} disabled={!hasPrev} className="min-h-11 sm:min-h-0">
            ← Prev
          </Button>
          <Button size="sm" variant="secondary" onClick={onNext} disabled={!hasNext} className="min-h-11 sm:min-h-0">
            Next →
          </Button>
        </div>
      </div>

      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-slate">
        <span>
          {ctx.style ? styleLabel(ctx.style) : "Style not set"}
        </span>
        <span aria-hidden>·</span>
        <span>
          {ctx.figuresResolved
            ? `${ctx.figureCount} ${ctx.figureCount === 1 ? "person or pet" : "people and pets"}`
            : "Number of people and pets not set"}
        </span>
        <span aria-hidden>·</span>
        <span>Designer: {ctx.designerName ?? "Unassigned"}</span>
        {ctx.styleGuessed && <Badge variant="warning">Style was guessed, please check it</Badge>}
        {!ctx.figuresResolved && <Badge variant="warning">Not set</Badge>}
      </p>
    </header>
  );
}
