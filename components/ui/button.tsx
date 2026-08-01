import { cn } from "@/lib/utils";
import { focusRing } from "./styles";
import { Spinner } from "./icons";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md" | "lg";

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
};

const variants: Record<ButtonVariant, string> = {
  primary:
    "bg-pigment text-surface hover:opacity-90 hover:shadow-md active:opacity-100",
  secondary:
    "bg-surface text-ink border border-line hover:bg-canvas hover:border-slate/40",
  ghost: "bg-transparent text-ink hover:bg-pigment-soft",
  danger: "bg-rose text-surface hover:opacity-90 hover:shadow-md",
};

const sizes: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-sm gap-1.5",
  md: "h-10 px-4 text-sm gap-2",
  lg: "h-12 px-5 text-base gap-2",
};

export function Button({
  className,
  variant = "primary",
  size = "md",
  loading = false,
  disabled,
  children,
  type = "button",
  ...props
}: ButtonProps) {
  const isDisabled = disabled || loading;
  return (
    <button
      type={type}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      className={cn(
        "relative inline-flex items-center justify-center rounded-input font-medium select-none",
        "transition-[transform,box-shadow,background-color,opacity,border-color] duration-[120ms]",
        "motion-hover active:scale-[0.98]",
        "disabled:pointer-events-none disabled:opacity-50",
        focusRing,
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    >
      {loading && (
        <span className="absolute inset-0 flex items-center justify-center">
          <Spinner size={size === "lg" ? 20 : 16} />
        </span>
      )}
      <span
        className={cn(
          "inline-flex items-center gap-[inherit]",
          loading && "invisible",
        )}
      >
        {children}
      </span>
    </button>
  );
}
