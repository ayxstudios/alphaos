"use client";

import { cn } from "@/lib/utils";
import { CHART, type ChartColor } from "./use-width";

/**
 * A ratio against a limit. The fill carries severity (calm under 70%,
 * amber to 100%, rose past it); the track is the same ramp's lightest step.
 * Always paired with a text value, never colour alone.
 */
export function Meter({
  value,
  max,
  label,
  hint,
  color,
  className,
}: {
  value: number;
  max: number;
  label: string;
  hint?: string;
  /** Force a colour (e.g. one designer row in a list); otherwise severity. */
  color?: ChartColor;
  className?: string;
}) {
  const pct = max > 0 ? value / max : 0;
  const tone: ChartColor = color ?? (pct > 1 ? "c4" : pct >= 0.7 ? "c3" : "c2");
  const w = Math.min(100, Math.round(pct * 100));
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="min-w-0 truncate text-ink">{label}</span>
        <span className="shrink-0 tabular-nums text-slate">
          <span className="font-medium text-ink">{value}</span>
          {max > 0 ? ` / ${max}` : ""}
          {hint ? <span className="ml-2 text-xs">{hint}</span> : null}
        </span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full" style={{ background: CHART.track }} role="meter" aria-valuenow={value} aria-valuemin={0} aria-valuemax={max || undefined} aria-label={label}>
        <div className="h-full rounded-full transition-[width] duration-300 ease-standard" style={{ width: `${w}%`, background: CHART[tone] }} />
      </div>
    </div>
  );
}
