import { cn } from "@/lib/utils";

export function Page({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "mx-auto flex w-full max-w-[1440px] flex-col gap-5",
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
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        {eyebrow && (
          <div className="mb-1 text-xs font-medium text-slate">{eyebrow}</div>
        )}
        <h1 className="font-display text-2xl font-semibold tracking-normal text-ink">
          {title}
        </h1>
        {description && (
          <p className="mt-1 max-w-2xl text-sm text-slate">{description}</p>
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

export function StatCard({
  label,
  value,
  detail,
  tone = "neutral",
}: {
  label: string;
  value: React.ReactNode;
  detail?: React.ReactNode;
  tone?: "neutral" | "info" | "success" | "warning" | "danger";
}) {
  const toneClass = {
    neutral: "border-line",
    info: "border-pigment/20",
    success: "border-sage/20",
    warning: "border-amber/25",
    danger: "border-rose/20",
  }[tone];
  return (
    <div
      className={cn("rounded-card border bg-surface p-4 shadow-sm", toneClass)}
    >
      <div className="text-xs font-medium uppercase tracking-wide text-slate">
        {label}
      </div>
      <div className="mt-2 text-2xl font-semibold text-ink">{value}</div>
      {detail && <div className="mt-1 text-xs text-slate">{detail}</div>}
    </div>
  );
}

export function DataPanel({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <section
      className={cn(
        "rounded-card border border-line bg-surface shadow-sm",
        className,
      )}
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
        "flex flex-wrap items-center gap-2 rounded-card border border-line bg-surface p-2 shadow-sm",
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
      className={cn(
        "overflow-hidden rounded-card border border-line bg-surface shadow-sm",
        className,
      )}
      {...props}
    />
  );
}
