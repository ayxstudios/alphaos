import { cn } from "@/lib/utils";

/**
 * Page primitives. The "calm" rule (owner 2026-09-10): a page opens on its
 * one obvious thing; explanations are one short line or none; controls that
 * are only needed once you act (filters, bulk actions, exports) sit behind a
 * single button or appear on selection. Nothing is removed, it is just not
 * shouting.
 */
export function Page({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "mx-auto flex w-full max-w-[1280px] flex-col gap-6",
        className,
      )}
      {...props}
    />
  );
}

export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  eyebrow?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        {eyebrow && (
          <div className="mb-1 text-xs font-medium text-slate/80">{eyebrow}</div>
        )}
        <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">
          {title}
        </h1>
        {description && (
          <p className="mt-1 max-w-xl text-sm text-slate">{description}</p>
        )}
      </div>
      {actions && (
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {actions}
        </div>
      )}
    </div>
  );
}

export function SectionHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-2">
      <div>
        <h2 className="text-base font-semibold text-ink">{title}</h2>
        {description && (
          <p className="mt-0.5 text-sm text-slate">{description}</p>
        )}
      </div>
      {actions}
    </div>
  );
}

const TONE_DOT = {
  neutral: "bg-slate/40",
  info: "bg-pigment",
  success: "bg-sage",
  warning: "bg-amber",
  danger: "bg-rose",
} as const;

/**
 * A number that matters. Tone is a small dot, never a coloured border, so a
 * row of four reads as one calm group.
 */
export function StatCard({
  label,
  value,
  detail,
  tone = "neutral",
}: {
  label: string;
  value: React.ReactNode;
  detail?: React.ReactNode;
  tone?: keyof typeof TONE_DOT;
}) {
  return (
    <div className="rounded-card bg-surface p-4 shadow-card">
      <div className="flex items-center gap-1.5 text-xs font-medium text-slate">
        {tone !== "neutral" && <span className={cn("size-1.5 rounded-full", TONE_DOT[tone])} />}
        {label}
      </div>
      <div className="mt-1.5 font-display text-2xl font-semibold tabular-nums text-ink">{value}</div>
      {detail && <div className="mt-1 text-xs text-slate">{detail}</div>}
    </div>
  );
}

/** A surface for content: soft shadow, no hard border. */
export function DataPanel({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <section
      className={cn("rounded-card bg-surface shadow-card", className)}
      {...props}
    />
  );
}

export function FilterBar({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-2 rounded-card bg-surface p-2 shadow-card",
        className,
      )}
      {...props}
    />
  );
}

export function TableShell({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("overflow-hidden rounded-card bg-surface shadow-card", className)}
      {...props}
    />
  );
}

/**
 * Progressive disclosure: a labelled row that opens to reveal the rest.
 * Native <details>, so it works without JS and keeps every child reachable.
 */
export function Disclosure({
  summary,
  hint,
  defaultOpen = false,
  className,
  children,
}: {
  summary: React.ReactNode;
  hint?: React.ReactNode;
  defaultOpen?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <details className={cn("group rounded-card bg-surface shadow-card", className)} open={defaultOpen || undefined}>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-medium text-ink [&::-webkit-details-marker]:hidden">
        <span className="flex min-w-0 items-center gap-2">
          {summary}
          {hint && <span className="truncate text-xs font-normal text-slate">{hint}</span>}
        </span>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0 text-slate transition-transform group-open:rotate-90">
          <path d="M9 6l6 6-6 6" />
        </svg>
      </summary>
      <div className="border-t border-line/70 px-4 py-3">{children}</div>
    </details>
  );
}
