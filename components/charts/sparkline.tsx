"use client";

import { useState } from "react";

import { CHART, useWidth, type ChartColor } from "./use-width";
import { ChartTooltip } from "./tooltip";

/**
 * A single-series trend: 2px line, soft area, last-point marker with a 2px
 * surface ring, crosshair tooltip on hover. No axes: the tile's value and
 * delta carry the numbers.
 */
export function Sparkline({
  points,
  labels,
  color = "c1",
  height = 44,
  format = (n: number) => String(n),
  ariaLabel,
}: {
  points: number[];
  labels: string[];
  color?: ChartColor;
  height?: number;
  format?: (n: number) => string;
  ariaLabel?: string;
}) {
  const { ref, width } = useWidth<HTMLDivElement>(200);
  const [hover, setHover] = useState<number | null>(null);
  const n = points.length;
  const max = Math.max(1, ...points);
  const padY = 4;
  const padX = 6;
  const stepX = n > 1 ? (width - padX * 2) / (n - 1) : 0;
  const px = (i: number) => padX + i * stepX;
  const py = (v: number) => padY + (1 - v / max) * (height - padY * 2);
  const d = points.map((v, i) => `${i === 0 ? "M" : "L"}${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(" ");
  const area = n > 1 ? `${d} L${px(n - 1).toFixed(1)},${height} L${px(0).toFixed(1)},${height} Z` : "";
  const stroke = CHART[color];

  return (
    <div
      ref={ref}
      className="relative w-full"
      style={{ height }}
      onMouseMove={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const i = stepX > 0 ? Math.round((x - padX) / stepX) : 0;
        setHover(Math.min(n - 1, Math.max(0, i)));
      }}
      onMouseLeave={() => setHover(null)}
    >
      <svg width={width} height={height} role="img" aria-label={ariaLabel}>
        {area && <path d={area} fill={stroke} opacity={0.1} />}
        {n > 1 && <path d={d} fill="none" stroke={stroke} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />}
        {n > 0 && (
          <circle cx={px(n - 1)} cy={py(points[n - 1])} r={4} fill={stroke} stroke={CHART.surface} strokeWidth={2} />
        )}
        {hover !== null && (
          <>
            <line x1={px(hover)} x2={px(hover)} y1={0} y2={height} stroke={CHART.line} strokeWidth={1} />
            <circle cx={px(hover)} cy={py(points[hover])} r={4} fill={stroke} stroke={CHART.surface} strokeWidth={2} />
          </>
        )}
      </svg>
      {hover !== null && (
        <ChartTooltip x={px(hover)} y={py(points[hover])} width={width} title={labels[hover] ?? ""} rows={[{ label: "Value", value: format(points[hover]), color: stroke }]} />
      )}
    </div>
  );
}
