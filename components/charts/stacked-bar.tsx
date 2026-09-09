"use client";

import { useState } from "react";

import { CHART, useWidth, type ChartColor } from "./use-width";
import { fmtInt } from "./format";
import { ChartTooltip, Legend } from "./tooltip";

export type Segment = { key: string; label: string; value: number; color: ChartColor; href?: string };

/**
 * Part-to-whole as one horizontal stacked bar with 2px surface gaps between
 * segments and a legend that doubles as the direct labels (name + count).
 * Fixed segment order: colour follows the entity, never its size.
 */
export function StackedBar({
  segments,
  height = 18,
  format = fmtInt,
  ariaLabel,
  emptyLabel = "Nothing here",
}: {
  segments: Segment[];
  height?: number;
  format?: (n: number) => string;
  ariaLabel?: string;
  emptyLabel?: string;
}) {
  const { ref, width } = useWidth<HTMLDivElement>(320);
  const [hover, setHover] = useState<number | null>(null);
  const total = segments.reduce((a, s) => a + s.value, 0);
  const gap = 2;
  const nonEmpty = segments.filter((s) => s.value > 0).length;
  const usable = Math.max(0, width - gap * Math.max(0, nonEmpty - 1));
  let x = 0;
  const rects = segments.map((s, i) => {
    const w = total > 0 ? (s.value / total) * usable : 0;
    const r = { i, x, w, s };
    if (s.value > 0) x += w + gap;
    return r;
  });

  return (
    <div className="flex flex-col gap-2.5">
      <div ref={ref} className="relative w-full" style={{ height }}>
        <svg width={width} height={height} role="img" aria-label={ariaLabel}>
          <rect x={0} y={0} width={width} height={height} rx={4} fill={CHART.track} />
          {total > 0 &&
            rects.map(({ i, x, w, s }) =>
              w <= 0 ? null : (
                <rect
                  key={s.key}
                  x={x}
                  y={0}
                  width={w}
                  height={height}
                  rx={3}
                  fill={CHART[s.color]}
                  opacity={hover === null || hover === i ? 1 : 0.5}
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover(null)}
                />
              ),
            )}
        </svg>
        {hover !== null && rects[hover] && (
          <ChartTooltip
            x={rects[hover].x + rects[hover].w / 2}
            y={0}
            width={width}
            title={rects[hover].s.label}
            rows={[
              { label: "Orders", value: format(rects[hover].s.value), color: CHART[rects[hover].s.color] },
              { label: "Share", value: total ? `${Math.round((rects[hover].s.value / total) * 100)}%` : "0%" },
            ]}
          />
        )}
      </div>
      {total === 0 ? (
        <p className="text-xs text-slate">{emptyLabel}</p>
      ) : (
        <Legend items={segments.map((s) => ({ label: s.label, color: CHART[s.color], value: format(s.value) }))} />
      )}
    </div>
  );
}
