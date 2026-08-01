import { cn } from "@/lib/utils";

type Side = "top" | "bottom" | "left" | "right";

export type TooltipProps = {
  content: React.ReactNode;
  side?: Side;
  children: React.ReactNode;
  className?: string;
};

const sideClasses: Record<Side, string> = {
  top: "bottom-full left-1/2 -translate-x-1/2 mb-2",
  bottom: "top-full left-1/2 -translate-x-1/2 mt-2",
  left: "right-full top-1/2 -translate-y-1/2 mr-2",
  right: "left-full top-1/2 -translate-y-1/2 ml-2",
};

/**
 * CSS-only tooltip: appears on hover AND keyboard focus of the trigger, so it
 * works without JavaScript and stays accessible.
 */
export function Tooltip({
  content,
  side = "top",
  children,
  className,
}: TooltipProps) {
  return (
    <span className="group relative inline-flex">
      {children}
      <span
        role="tooltip"
        className={cn(
          "pointer-events-none absolute z-50 w-max max-w-xs rounded-input bg-ink px-2 py-1",
          "text-xs font-medium text-surface shadow-md",
          "opacity-0 transition-opacity motion-hover",
          "group-hover:opacity-100 group-focus-within:opacity-100",
          sideClasses[side],
          className,
        )}
      >
        {content}
      </span>
    </span>
  );
}
