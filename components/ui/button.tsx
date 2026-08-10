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
    "bg-pigment text-surface shadow-sm hover:bg-[#233e70] hover:shadow-md active:bg-[#1c3159]",
  secondary:
    "bg-surface text-ink border border-line shadow-sm hover:border-pigment/40 hover:bg-pigment-soft/40",
  ghost: "bg-transparent text-slate hover:bg-canvas hover:text-ink",
  danger:
    "bg-rose text-surface shadow-sm hover:bg-[#96304a] hover:shadow-md active:bg-[#7f2940]",
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
        "relative inline-flex items-center justify-center rounded-input font-semibold select-none cursor-pointer",
        "transition-[transform,box-shadow,background-color,opacity,border-color] duration-[120ms]",
        "motion-hover active:scale-[0.98]",
        "disabled:pointer-events-none disabled:opacity-50 disabled:cursor-not-allowed",
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
