"use client";

import { useState } from "react";

import { cn } from "@/lib/utils";
import { CHART, type ChartColor } from "./use-width";
import { fmtInt } from "./format";

export type HBarRow = { key: string; label: string; value: number; color?: ChartColor; hint?: string };

/**
 * Horizontal bars for categories with real names (kinds, shops, people).
 * Label left, thin bar, value right in text ink. One hue by default
 * (magnitude), a per-row colour only when the row IS the entity.
 */
export function HBars({ rows, color = "c1", format = fmtInt, max: maxProp, className }: { rows: HBarRow[]; color?: ChartColor; format?: (n: number) => string; max?: number; className?: string }) {
  const [hover, setHover] = useState<string | null>(null);
  const max = Math.max(1, maxProp ?? Math.max(0, ...rows.map((r) => r.value)));
  return (
    <ul className={cn("flex flex-col gap-2", className)} role="list">
      {rows.map((r) => (
        <li
          key={r.key}
          className="grid grid-cols-[minmax(4.5rem,9rem)_1fr_auto] items-center gap-3 text-sm"
          onMouseEnter={() => setHover(r.key)}
          onMouseLeave={() => setHover(null)}
        >
          <span className="min-w-0 truncate text-ink" title={r.label}>
            {r.label}
          </span>
          <span className="h-2.5 w-full overflow-hidden rounded-full" style={{ background: CHART.track }} aria-hidden>
            <span
              className="block h-full rounded-full transition-[width] duration-300 ease-standard"
              style={{ width: `${Math.round((r.value / max) * 100)}%`, background: CHART[r.color ?? color], opacity: hover === null || hover === r.key ? 1 : 0.6 }}
            />
          </span>
          <span className="w-10 text-right tabular-nums text-ink">
            {format(r.value)}
            {r.hint && <span className="ml-1 text-xs text-slate">{r.hint}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}
