"use client";

import { cn } from "@/lib/utils";

/**
 * One tooltip for every chart: positioned by the parent in container pixels,
 * flips left near the right edge, text tokens only (never a series colour on
 * text; the swatch carries identity).
 */
export function ChartTooltip({
  x,
  y,
  width,
  title,
  rows,
}: {
  x: number;
  y: number;
  width: number;
  title: string;
  rows: { label: string; value: string; color?: string }[];
}) {
  const flip = x > width * 0.62;
  return (
    <div
      role="status"
      className={cn(
        "pointer-events-none absolute z-20 min-w-28 rounded-input border border-line bg-surface px-2.5 py-2 text-xs shadow-md",
        flip ? "-translate-x-full" : "",
      )}
      style={{ left: flip ? x - 8 : x + 8, top: Math.max(0, y - 8) }}
    >
      <div className="mb-1 font-medium text-ink">{title}</div>
      {rows.map((r) => (
        <div key={r.label} className="flex items-center justify-between gap-3 text-slate">
          <span className="flex items-center gap-1.5">
            {r.color && <span aria-hidden className="size-2 rounded-full" style={{ background: r.color }} />}
            {r.label}
          </span>
          <span className="tabular-nums text-ink">{r.value}</span>
        </div>
      ))}
    </div>
  );
}

export function Legend({ items }: { items: { label: string; color: string; value?: string }[] }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate">
      {items.map((it) => (
        <li key={it.label} className="flex items-center gap-1.5">
          <span aria-hidden className="size-2.5 rounded-sm" style={{ background: it.color }} />
          <span>{it.label}</span>
          {it.value !== undefined && <span className="tabular-nums text-ink">{it.value}</span>}
        </li>
      ))}
    </ul>
  );
}
