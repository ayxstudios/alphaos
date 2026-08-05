"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { cn } from "@/lib/utils";
import { Avatar, useToast } from "@/components/ui";
import { focusRing } from "@/components/ui/styles";
import { ChevronDown } from "@/components/ui/icons";
import { moveDesigner, setDailyLimit, setStyles } from "@/app/(app)/designers/actions";
import type { DesignerRow } from "@/lib/designers/roster";

export function DesignerRoster({
  designers,
  canEdit,
}: {
  designers: DesignerRow[];
  canEdit: boolean;
}) {
  return (
    <div className="overflow-hidden rounded-card border border-line bg-surface shadow-sm">
      <div className="hidden grid-cols-[5rem_1fr_1.6fr_7rem_11rem] gap-3 border-b border-line px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-slate lg:grid">
        <span>Rank</span>
        <span>Designer</span>
        <span>Styles</span>
        <span>Daily limit</span>
        <span>Assigned today</span>
      </div>
      <ul className="divide-y divide-line">
        {designers.map((d, i) => (
          <Row
            key={d.userId}
            d={d}
            first={i === 0}
            last={i === designers.length - 1}
            canEdit={canEdit}
          />
        ))}
      </ul>
    </div>
  );
}

function Row({
  d,
  first,
  last,
  canEdit,
}: {
  d: DesignerRow;
  first: boolean;
  last: boolean;
  canEdit: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [limit, setLimit] = useState(String(d.dailyCapacity));
  const [styles, setStylesInput] = useState(d.styles.join(", "));

  // Re-sync inputs when the server value changes (after a refresh).
  useEffect(() => setLimit(String(d.dailyCapacity)), [d.dailyCapacity]);
  useEffect(() => setStylesInput(d.styles.join(", ")), [d.styles]);

  function run(fn: () => Promise<{ ok: boolean; message?: string }>) {
    start(async () => {
      const res = await fn();
      if (!res.ok) {
        toast({ variant: "danger", title: "Update failed", description: res.message });
      }
      router.refresh();
    });
  }

  function commitLimit() {
    const n = parseInt(limit, 10);
    if (!Number.isFinite(n) || n === d.dailyCapacity) {
      setLimit(String(d.dailyCapacity));
      return;
    }
    run(() => setDailyLimit(d.userId, n));
  }

  function commitStyles() {
    const arr = styles.split(",").map((s) => s.trim()).filter(Boolean);
    const norm = (xs: string[]) => xs.map((s) => s.toLowerCase()).join("");
    if (norm(arr) === norm(d.styles)) {
      setStylesInput(d.styles.join(", "));
      return;
    }
    run(() => setStyles(d.userId, arr));
  }

  const atLimit = d.dailyCapacity > 0 && d.assignedToday >= d.dailyCapacity;
  const pct = d.dailyCapacity > 0 ? Math.min(100, (d.assignedToday / d.dailyCapacity) * 100) : 0;

  return (
    <li
      className={cn(
        "grid grid-cols-1 gap-3 px-4 py-3 lg:grid-cols-[5rem_1fr_1.6fr_7rem_11rem] lg:items-center",
        pending && "opacity-60",
      )}
    >
      {/* Rank + reorder */}
      <div className="flex items-center gap-2">
        <span className="w-6 text-sm font-semibold tabular-nums text-ink">{d.rank + 1}</span>
        {canEdit && (
          <div className="flex flex-col">
            <button
              type="button"
              aria-label="Move up"
              disabled={first || pending}
              onClick={() => run(() => moveDesigner(d.userId, "up"))}
              className={cn(
                "flex size-5 items-center justify-center rounded text-slate hover:bg-canvas hover:text-ink disabled:opacity-30",
                focusRing,
              )}
            >
              <ChevronDown size={14} className="rotate-180" />
            </button>
            <button
              type="button"
              aria-label="Move down"
              disabled={last || pending}
              onClick={() => run(() => moveDesigner(d.userId, "down"))}
              className={cn(
                "flex size-5 items-center justify-center rounded text-slate hover:bg-canvas hover:text-ink disabled:opacity-30",
                focusRing,
              )}
            >
              <ChevronDown size={14} />
            </button>
          </div>
        )}
      </div>

      {/* Designer */}
      <div className="flex min-w-0 items-center gap-2.5">
        <Avatar name={d.name} size="sm" />
        <span className="truncate text-sm font-medium text-ink">{d.name}</span>
      </div>

      {/* Styles */}
      <div>
        {canEdit ? (
          <input
            value={styles}
            onChange={(e) => setStylesInput(e.target.value)}
            onBlur={commitStyles}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
            placeholder="Disney, Anime, Watercolour…"
            className={cn(
              "h-9 w-full rounded-input border border-line bg-surface px-2.5 text-sm text-ink placeholder:text-slate",
              focusRing,
            )}
          />
        ) : d.styles.length ? (
          <div className="flex flex-wrap gap-1">
            {d.styles.map((s) => (
              <span key={s} className="rounded bg-sage/10 px-1.5 py-0.5 text-xs text-sage">
                {s}
              </span>
            ))}
          </div>
        ) : (
          <span className="text-xs text-slate">Any style</span>
        )}
      </div>

      {/* Daily limit */}
      <div>
        {canEdit ? (
          <input
            type="number"
            min={0}
            inputMode="numeric"
            value={limit}
            onChange={(e) => setLimit(e.target.value)}
            onBlur={commitLimit}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
            className={cn(
              "h-9 w-20 rounded-input border border-line bg-surface px-2.5 text-sm tabular-nums text-ink",
              focusRing,
            )}
          />
        ) : (
          <span className="text-sm tabular-nums text-ink">{d.dailyCapacity}</span>
        )}
      </div>

      {/* Assigned today */}
      <div className="space-y-1">
        <div className="flex items-center justify-between text-xs">
          <span className={cn("font-medium tabular-nums", atLimit ? "text-rose" : "text-ink")}>
            {d.assignedToday} / {d.dailyCapacity}
          </span>
          <span className="text-slate">{d.wipCount} in flight</span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-canvas">
          <div
            className={cn("h-full rounded-full", atLimit ? "bg-rose" : "bg-pigment")}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
    </li>
  );
}
