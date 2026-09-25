import { forwardRef } from "react";

import { cn } from "@/lib/utils";
import { Check } from "./icons";

export type CheckboxProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, "type">;

/**
 * A checkbox whose real input is the whole 44px tap area on a phone (20px box
 * drawn inside it, negative margin so rows keep their spacing) and a 16px box
 * on a laptop. The native input stays in the page (invisible, on top), so
 * forms, labels, keyboard and screen readers work exactly as before.
 */
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { className, ...props },
  ref,
) {
  return (
    <span className={cn("relative -m-3 inline-flex size-11 shrink-0 items-center justify-center sm:m-0 sm:size-4", className)}>
      <input
        ref={ref}
        type="checkbox"
        className="peer absolute inset-0 z-10 m-0 size-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
        {...props}
      />
      <span
        aria-hidden
        className={cn(
          "pointer-events-none flex size-5 items-center justify-center rounded border border-slate/60 bg-surface text-surface sm:size-4",
          "transition-colors motion-hover",
          "peer-checked:border-pigment peer-checked:bg-pigment [&>svg]:opacity-0 peer-checked:[&>svg]:opacity-100",
          "peer-focus-visible:ring-2 peer-focus-visible:ring-pigment peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-canvas",
          "peer-disabled:opacity-50",
        )}
      >
        <Check size={14} strokeWidth={3} className="sm:size-3" />
      </span>
    </span>
  );
});
