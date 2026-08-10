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
          <div className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-pigment">
            {eyebrow}
          </div>
        )}
        <h1 className="font-display text-2xl tracking-tight text-ink">
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
  icon,
}: {
  label: string;
  value: React.ReactNode;
  detail?: React.ReactNode;
  tone?: "neutral" | "info" | "success" | "warning" | "danger";
  icon?: React.ReactNode;
}) {
  const accentClass = {
    neutral: "bg-line",
    info: "bg-pigment",
    success: "bg-sage",
    warning: "bg-amber",
    danger: "bg-rose",
  }[tone];
  const iconToneClass = {
    neutral: "bg-canvas text-slate",
    info: "bg-pigment-soft text-pigment",
    success: "bg-sage/10 text-sage",
    warning: "bg-amber/10 text-amber",
    danger: "bg-rose/10 text-rose",
  }[tone];
  return (
    <div className="relative overflow-hidden rounded-card border border-line bg-surface p-5 shadow-sm">
      <span
        className={cn("absolute inset-x-0 top-0 h-[3px]", accentClass)}
        aria-hidden="true"
      />
      <div className="flex items-start justify-between gap-3">
        <div className="text-xs font-semibold uppercase tracking-wide text-slate">
          {label}
        </div>
        {icon && (
          <span
            className={cn(
              "flex size-8 shrink-0 items-center justify-center rounded-full",
              iconToneClass,
            )}
            aria-hidden="true"
          >
            {icon}
          </span>
        )}
      </div>
      <div className="mt-2 font-display text-2xl tracking-tight text-ink tabular-nums">
        {value}
      </div>
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
