import Link from "next/link";

import { cn } from "@/lib/utils";
import { ArrowRight } from "@/components/ui/icons";
import { Sparkline } from "@/components/charts";
import type { ChartColor } from "@/components/charts";

/**
 * A stat tile: label, one big number, an optional delta and sparkline.
 * The tile's value carries the number; the sparkline is context only.
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
  /** Percent change vs the previous window; `good` says which direction is good. */
  delta?: { pct: number | null | undefined; good: "up" | "down"; window: string };
  spark?: { points: number[]; labels: string[]; color?: ChartColor; format?: (n: number) => string };
  tone?: "neutral" | "good" | "warn" | "bad";
  href?: string;
  hint?: string;
}) {
  const valueClass = {
    neutral: "text-ink",
    good: "text-sage",
    warn: "text-amber",
    bad: "text-rose",
  }[tone];
  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-slate">{label}</span>
        {href && <ArrowRight size={14} className="mt-0.5 shrink-0 text-slate opacity-0 transition-opacity group-hover:opacity-100" />}
      </div>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span className={cn("font-display text-2xl font-semibold tabular-nums leading-none sm:text-[32px]", valueClass)}>{value}</span>
        {unit && <span className="text-sm text-slate">{unit}</span>}
      </div>
      {(delta || hint) && (
        <div className="mt-1.5 flex items-start gap-1.5 text-xs text-slate">
          {delta && delta.pct !== undefined && <DeltaPill pct={delta.pct} good={delta.good} />}
          <span className="line-clamp-2">{delta ? delta.window : hint}</span>
        </div>
      )}
      {spark && (
        <div className="mt-2">
          <Sparkline points={spark.points} labels={spark.labels} color={spark.color} height={36} format={spark.format} ariaLabel={`${label}, last ${spark.points.length} days`} />
        </div>
      )}
    </>
  );
  const cls = "group flex min-w-0 flex-col rounded-card border border-line bg-surface p-4 shadow-sm";
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

export function HomeSection({
  title,
  description,
  action,
  children,
  className,
}: {
  title: string;
  description?: string;
  action?: { label: string; href: string };
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("flex min-w-0 flex-col gap-4 rounded-card border border-line bg-surface p-4 shadow-sm sm:p-5", className)}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-ink">{title}</h2>
          {description && <p className="mt-0.5 text-sm text-slate">{description}</p>}
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

export function TileSkeleton({ n = 4 }: { n?: number }) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {Array.from({ length: n }).map((_, i) => (
        <div key={i} className="h-28 animate-pulse rounded-card border border-line bg-surface" />
      ))}
    </div>
  );
}

export function SectionSkeleton({ h = 220 }: { h?: number }) {
  return <div className="animate-pulse rounded-card border border-line bg-surface" style={{ height: h }} />;
}
