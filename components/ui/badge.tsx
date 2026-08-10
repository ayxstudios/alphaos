import { cn } from "@/lib/utils";

type BadgeVariant = "neutral" | "info" | "success" | "warning" | "danger";

export type BadgeProps = React.HTMLAttributes<HTMLSpanElement> & {
  variant?: BadgeVariant;
  dot?: boolean;
};

// Alpha modifiers of palette tokens only.
const variants: Record<BadgeVariant, string> = {
  neutral: "text-slate bg-canvas ring-line",
  info: "text-pigment bg-pigment-soft ring-pigment/15",
  success: "text-sage bg-sage/[0.1] ring-sage/20",
  warning: "text-amber bg-amber/[0.1] ring-amber/20",
  danger: "text-rose bg-rose/[0.1] ring-rose/20",
};

// Rectangular chip (not a pill) — reads as "tag/metadata", distinct from the
// pill-shaped StatusChip which reads as "workflow state".
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
        "inline-flex items-center gap-1.5 rounded-chip px-2 py-0.5 text-xs font-medium ring-1 ring-inset",
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
