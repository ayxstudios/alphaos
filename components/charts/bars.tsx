"use client";

import { useState } from "react";

import { CHART, useWidth, type ChartColor } from "./use-width";
import { fmtInt, niceMax } from "./format";
import { ChartTooltip, Legend } from "./tooltip";

export type BarSeries = { name: string; color: ChartColor; values: number[] };

/**
 * Grouped columns over a category axis (days, kinds). Thin marks, 4px rounded
 * caps anchored to the baseline, a 2px surface gap between neighbours, three
 * recessive gridlines, a hover band with one tooltip for the whole group, a
 * legend once there are two series. Values on demand, never on every column.
 */
export function Bars({
  series,
  labels,
  height = 180,
  format = fmtInt,
  ariaLabel,
  tickEvery,
}: {
  series: BarSeries[];
  labels: string[];
  height?: number;
  format?: (n: number) => string;
  ariaLabel?: string;
  /** Show every nth x label (auto when omitted). */
  tickEvery?: number;
}) {
  const { ref, width } = useWidth<HTMLDivElement>(320);
  const [hover, setHover] = useState<number | null>(null);
  const n = labels.length;
  const top = 8;
  const bottom = 22;
  const left = 30;
  const plotW = Math.max(0, width - left);
  const plotH = height - top - bottom;
  const rawMax = Math.max(0, ...series.flatMap((s) => s.values));
  const max = niceMax(rawMax);
  const groupW = n > 0 ? plotW / n : 0;
  const gap = 2;
  const innerPad = Math.min(10, groupW * 0.18);
  const barW = Math.max(3, (groupW - innerPad * 2 - gap * (series.length - 1)) / Math.max(1, series.length));
  const y = (v: number) => top + (1 - v / max) * plotH;
  const every = tickEvery ?? (groupW < 26 ? Math.ceil(26 / Math.max(1, groupW)) : 1);
  const ticks = [0, 0.5, 1].map((f) => f * max);

  return (
    <div className="flex flex-col gap-2">
      <div
        ref={ref}
        className="relative w-full"
        style={{ height }}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const x = e.clientX - rect.left - left;
          if (x < 0 || groupW === 0) return setHover(null);
          setHover(Math.min(n - 1, Math.max(0, Math.floor(x / groupW))));
        }}
        onMouseLeave={() => setHover(null)}
      >
        <svg width={width} height={height} role="img" aria-label={ariaLabel}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={left} x2={width} y1={y(t)} y2={y(t)} stroke={CHART.line} strokeWidth={1} />
              <text x={left - 6} y={y(t) + 3.5} textAnchor="end" fontSize={10} fill={CHART.slate}>
                {format(t)}
              </text>
            </g>
          ))}
          {hover !== null && (
            <rect x={left + hover * groupW} y={top} width={groupW} height={plotH} fill={CHART.track} opacity={0.6} />
          )}
          {labels.map((lab, i) => (
            <g key={lab + i}>
              {series.map((s, si) => {
                const v = s.values[i] ?? 0;
                const h = Math.max(0, y(0) - y(v));
                const x = left + i * groupW + innerPad + si * (barW + gap);
                const r = Math.min(4, barW / 2, h);
                return (
                  <path
                    key={s.name}
                    d={
                      h === 0
                        ? ""
                        : `M${x},${y(0)} V${y(v) + r} Q${x},${y(v)} ${x + r},${y(v)} H${x + barW - r} Q${x + barW},${y(v)} ${x + barW},${y(v) + r} V${y(0)} Z`
                    }
                    fill={CHART[s.color]}
                    opacity={hover === null || hover === i ? 1 : 0.55}
                  />
                );
              })}
              {i % every === 0 && (
                <text x={left + i * groupW + groupW / 2} y={height - 6} textAnchor="middle" fontSize={10} fill={CHART.slate}>
                  {lab}
                </text>
              )}
            </g>
          ))}
          <line x1={left} x2={width} y1={y(0)} y2={y(0)} stroke={CHART.line} strokeWidth={1} />
        </svg>
        {hover !== null && (
          <ChartTooltip
            x={left + hover * groupW + groupW / 2}
            y={top}
            width={width}
            title={labels[hover]}
            rows={series.map((s) => ({ label: s.name, value: format(s.values[hover] ?? 0), color: CHART[s.color] }))}
          />
        )}
      </div>
      {series.length > 1 && <Legend items={series.map((s) => ({ label: s.name, color: CHART[s.color] }))} />}
    </div>
  );
}
