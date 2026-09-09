import Link from "next/link";

import { cn } from "@/lib/utils";
import { ArrowRight } from "@/components/ui/icons";
import { Sparkline } from "@/components/charts";
import type { ChartColor } from "@/components/charts";

const TONE_DOT = {
  neutral: null,
  good: "bg-sage",
  warn: "bg-amber",
  bad: "bg-rose",
} as const;

/**
 * A stat tile: label, one big number, one quiet line of context and an
 * optional sparkline. Tone is a small dot next to the label (never a
 * coloured border), so four tiles read as one calm row.
 */
export function StatTile({
  label,
  value,
  unit,
  delta,
  spark,
  tone = "neutral",
  href,
  hint,
}: {
  label: string;
  value: string | number;
  unit?: string;
  /**
   * Percent change vs the previous window. `base` is the previous window's
   * count: a tiny base makes any percentage silly, so the pill is dropped
   * and `fallback` (or the window) is shown as plain text instead.
   */
  delta?: { pct: number | null | undefined; good: "up" | "down"; window: string; base?: number; fallback?: string };
  spark?: { points: number[]; labels: string[]; color?: ChartColor; format?: (n: number) => string };
  tone?: keyof typeof TONE_DOT;
  href?: string;
  hint?: string;
}) {
  const showPill = !!delta && delta.pct !== undefined && (delta.pct === null || ((delta.base ?? 10) >= 10 && Math.abs(delta.pct) <= 200));
  const context = delta ? (showPill ? delta.window : (delta.fallback ?? hint ?? delta.window)) : hint;
  const dot = TONE_DOT[tone];
  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-xs font-medium text-slate">
          {dot && <span className={cn("size-1.5 rounded-full", dot)} />}
          {label}
        </span>
        {href && <ArrowRight size={14} className="shrink-0 text-slate opacity-0 transition-opacity group-hover:opacity-100" />}
      </div>
      <div className="mt-2 flex items-baseline gap-1.5">
        <span className="font-display text-[26px] font-semibold tabular-nums leading-none text-ink sm:text-[30px]">{value}</span>
        {unit && <span className="text-sm text-slate">{unit}</span>}
      </div>
      {context && (
        <div className="mt-1.5 flex items-center gap-1.5 text-xs text-slate">
          {showPill && delta && <DeltaPill pct={delta.pct as number | null} good={delta.good} />}
          <span className="truncate">{context}</span>
        </div>
      )}
      {spark && (
        <div className="mt-3">
          <Sparkline points={spark.points} labels={spark.labels} color={spark.color} height={32} format={spark.format} ariaLabel={`${label}, last ${spark.points.length} days`} />
        </div>
      )}
    </>
  );
  const cls = "group flex min-w-0 flex-col rounded-card bg-surface p-4 shadow-card";
  return href ? (
    <Link href={href} className={cn(cls, "transition-[transform,box-shadow] duration-150 hover:-translate-y-0.5 hover:shadow-md")}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

export function DeltaPill({ pct, good }: { pct: number | null; good: "up" | "down" }) {
  if (pct === null) return <span className="rounded-chip bg-slate/10 px-1.5 py-0.5 font-medium text-slate">new</span>;
  const positive = pct > 0;
  const isGood = pct === 0 ? null : (positive && good === "up") || (!positive && good === "down");
  const cls = isGood === null ? "bg-slate/10 text-slate" : isGood ? "bg-sage/10 text-sage" : "bg-rose/10 text-rose";
  return (
    <span className={cn("rounded-chip px-1.5 py-0.5 font-medium tabular-nums", cls)}>
      {pct > 0 ? "+" : ""}
      {pct}%
    </span>
  );
}

/**
 * A section card. `quiet` is for the second row of context charts: same
 * card, a smaller title, so the eye lands on the hero above first.
 */
export function HomeSection({
  title,
  description,
  action,
  children,
  className,
  quiet = false,
}: {
  title: string;
  description?: string;
  action?: { label: string; href: string };
  children: React.ReactNode;
  className?: string;
  quiet?: boolean;
}) {
  return (
    <section className={cn("flex min-w-0 flex-col gap-4 rounded-card bg-surface p-4 shadow-card sm:p-5", className)}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className={cn("font-semibold text-ink", quiet ? "text-sm" : "text-base")}>{title}</h2>
          {description && <p className={cn("mt-0.5 text-slate", quiet ? "text-xs" : "text-sm")}>{description}</p>}
        </div>
        {action && (
          <Link href={action.href} className="inline-flex shrink-0 items-center gap-1 text-sm font-medium text-pigment hover:underline">
            {action.label}
            <ArrowRight size={14} />
          </Link>
        )}
      </div>
      {children}
    </section>
  );
}

/** One plain sentence about the day, under the greeting. */
export function DayLine({ children }: { children: React.ReactNode }) {
  return <p className="-mt-3 max-w-2xl text-base text-slate">{children}</p>;
}

/** The quiet label that separates the hero row from the context charts. */
export function RowLabel({ children }: { children: React.ReactNode }) {
  return <p className="mt-1 text-xs font-medium text-slate/80">{children}</p>;
}

export function TileSkeleton({ n = 4 }: { n?: number }) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {Array.from({ length: n }).map((_, i) => (
        <div key={i} className="h-28 animate-pulse rounded-card bg-surface shadow-card" />
      ))}
    </div>
  );
}

export function SectionSkeleton({ h = 220 }: { h?: number }) {
  return <div className="animate-pulse rounded-card bg-surface shadow-card" style={{ height: h }} />;
}
