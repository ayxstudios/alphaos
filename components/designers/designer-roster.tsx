"use client";

import { useEffect, useRef, useState, useTransition } from "react";

import { cn } from "@/lib/utils";
import { Avatar, useToast } from "@/components/ui";
import { focusRing } from "@/components/ui/styles";
import { ChevronDown, Check } from "@/components/ui/icons";
import { moveDesigner, setDailyLimit, setStyles } from "@/app/(app)/designers/actions";
import type { DesignerRow } from "@/lib/designers/roster";

type ActionResult = { ok: boolean; message?: string };

/**
 * Ranked designer roster. Every edit is OPTIMISTIC — the UI updates instantly
 * and the server action persists in the background (no blocking refresh), so it
 * feels immediate even with a slow round-trip. On failure we revert to the last
 * server state and toast.
 */
export function DesignerRoster({
  designers,
  styleOptions,
  canEdit,
}: {
  designers: DesignerRow[];
  styleOptions: string[];
  canEdit: boolean;
}) {
  const toast = useToast();
  const [list, setList] = useState(designers);
  const [, startBg] = useTransition();

  // Re-sync to the server's ordering/values on a genuine data refresh.
  useEffect(() => setList(designers), [designers]);

  function persist(optimistic: DesignerRow[], action: () => Promise<ActionResult>) {
    setList(optimistic);
    startBg(async () => {
      const res = await action();
      if (!res.ok) {
        setList(designers);
        toast({ variant: "danger", title: "Update failed", description: res.message });
      }
    });
  }

  function reorder(userId: string, dir: "up" | "down") {
    const idx = list.findIndex((d) => d.userId === userId);
    const swap = dir === "up" ? idx - 1 : idx + 1;
    if (idx < 0 || swap < 0 || swap >= list.length) return;
    const next = [...list];
    [next[idx], next[swap]] = [next[swap], next[idx]];
    persist(next, () => moveDesigner(userId, dir));
  }

  function patch(userId: string, patchRow: Partial<DesignerRow>, action: () => Promise<ActionResult>) {
    persist(
      list.map((d) => (d.userId === userId ? { ...d, ...patchRow } : d)),
      action,
    );
  }

  return (
    <div className="rounded-card border border-line bg-surface shadow-sm">
      <div className="hidden grid-cols-[5rem_1fr_1.6fr_7rem_11rem] gap-3 border-b border-line px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-slate lg:grid">
        <span>Rank</span>
        <span>Designer</span>
        <span>Styles</span>
        <span>Daily limit</span>
        <span>Assigned today</span>
      </div>
      <ul className="divide-y divide-line">
        {list.map((d, i) => (
          <Row
            key={d.userId}
            d={d}
            position={i + 1}
            first={i === 0}
            last={i === list.length - 1}
            canEdit={canEdit}
            styleOptions={styleOptions}
            onReorder={reorder}
            onLimit={(n) => patch(d.userId, { dailyCapacity: n }, () => setDailyLimit(d.userId, n))}
            onStyles={(styles) => patch(d.userId, { styles }, () => setStyles(d.userId, styles))}
          />
        ))}
      </ul>
    </div>
  );
}

function Row({
  d,
  position,
  first,
  last,
  canEdit,
  styleOptions,
  onReorder,
  onLimit,
  onStyles,
}: {
  d: DesignerRow;
  position: number;
  first: boolean;
  last: boolean;
  canEdit: boolean;
  styleOptions: string[];
  onReorder: (userId: string, dir: "up" | "down") => void;
  onLimit: (n: number) => void;
  onStyles: (styles: string[]) => void;
}) {
  const [limit, setLimit] = useState(String(d.dailyCapacity));
  useEffect(() => setLimit(String(d.dailyCapacity)), [d.dailyCapacity]);

  function commitLimit() {
    const n = parseInt(limit, 10);
    if (!Number.isFinite(n) || n === d.dailyCapacity) {
      setLimit(String(d.dailyCapacity));
      return;
    }
    onLimit(Math.max(0, n));
  }

  const atLimit = d.dailyCapacity > 0 && d.assignedToday >= d.dailyCapacity;
  const pct = d.dailyCapacity > 0 ? Math.min(100, (d.assignedToday / d.dailyCapacity) * 100) : 0;

  return (
    <li className="grid grid-cols-1 gap-3 px-4 py-3 lg:grid-cols-[5rem_1fr_1.6fr_7rem_11rem] lg:items-center">
      {/* Rank + reorder */}
      <div className="flex items-center gap-2">
        <span className="w-6 text-sm font-semibold tabular-nums text-ink">{position}</span>
        {canEdit && (
          <div className="flex flex-col">
            <button
              type="button"
              aria-label="Move up"
              disabled={first}
              onClick={() => onReorder(d.userId, "up")}
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
              disabled={last}
              onClick={() => onReorder(d.userId, "down")}
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
          <StyleSelect selected={d.styles} options={styleOptions} onChange={onStyles} />
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

/**
 * Add/remove designer styles — constrained to the shop-offered catalog. You can
 * only pick styles some shop actually sells; a designer can hold several.
 */
function StyleSelect({
  selected,
  options,
  onChange,
}: {
  selected: string[];
  options: string[];
  onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const selectedLower = new Set(selected.map((s) => s.toLowerCase()));
  function toggle(opt: string) {
    const l = opt.toLowerCase();
    onChange(
      selectedLower.has(l) ? selected.filter((s) => s.toLowerCase() !== l) : [...selected, opt],
    );
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex min-h-9 w-full items-center gap-1 rounded-input border border-line bg-surface px-2 py-1 text-left",
          focusRing,
        )}
      >
        <span className="flex min-w-0 flex-1 flex-wrap gap-1">
          {selected.length ? (
            selected.map((s) => (
              <span key={s} className="rounded bg-sage/10 px-1.5 py-0.5 text-xs text-sage">
                {s}
              </span>
            ))
          ) : (
            <span className="text-sm text-slate">Any style</span>
          )}
        </span>
        <ChevronDown size={15} className="shrink-0 text-slate" />
      </button>

      {open && (
        <div className="absolute left-0 top-full z-20 mt-1 max-h-64 w-full min-w-52 overflow-y-auto rounded-card border border-line bg-surface p-1 shadow-lg">
          {options.length === 0 ? (
            <p className="px-2 py-3 text-xs text-slate">
              No styles defined. Add them per shop in Settings → Styles.
            </p>
          ) : (
            options.map((opt) => {
              const on = selectedLower.has(opt.toLowerCase());
              return (
                <button
                  key={opt}
                  type="button"
                  onClick={() => toggle(opt)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-input px-2 py-1.5 text-left text-sm hover:bg-canvas",
                    focusRing,
                  )}
                >
                  <span
                    className={cn(
                      "flex size-4 shrink-0 items-center justify-center rounded border",
                      on ? "border-pigment bg-pigment text-surface" : "border-line",
                    )}
                  >
                    {on && <Check size={12} />}
                  </span>
                  <span className={cn(on ? "text-ink" : "text-slate")}>{opt}</span>
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
