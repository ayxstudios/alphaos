import { cn } from "@/lib/utils";

type BadgeVariant = "neutral" | "info" | "success" | "warning" | "danger";

export type BadgeProps = React.HTMLAttributes<HTMLSpanElement> & {
  variant?: BadgeVariant;
  dot?: boolean;
};

// Alpha modifiers of palette tokens only.
const variants: Record<BadgeVariant, string> = {
  neutral: "text-slate bg-slate/10 border-slate/20",
  info: "text-pigment bg-pigment-soft border-pigment/20",
  success: "text-sage bg-sage/10 border-sage/20",
  warning: "text-amber bg-amber/10 border-amber/25",
  danger: "text-rose bg-rose/10 border-rose/20",
};

export function Badge({
  className,
  variant = "neutral",
  dot = false,
  children,
  ...props
}: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-chip border px-2 py-0.5 text-xs font-medium",
        variants[variant],
        className,
      )}
      {...props}
    >
      {dot && (
        <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
      )}
      {children}
    </span>
  );
}
