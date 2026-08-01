"use client";

import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";
import { focusRing } from "@/components/ui/styles";

export type PopoverProps = {
  /** Trigger button contents. */
  trigger: React.ReactNode;
  triggerClassName?: string;
  ariaLabel?: string;
  align?: "start" | "end";
  /** Menu contents; receives a `close` callback. */
  children: (close: () => void) => React.ReactNode;
  menuClassName?: string;
};

export function Popover({
  trigger,
  triggerClassName,
  ariaLabel,
  align = "end",
  children,
  menuClassName,
}: PopoverProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cn(focusRing, triggerClassName)}
      >
        {trigger}
      </button>
      {open && (
        <div
          role="menu"
          className={cn(
            "absolute z-50 mt-2 min-w-52 rounded-card border border-line bg-surface p-1 shadow-lg",
            "[animation:alpha-toast-in_160ms_var(--ease-standard)]",
            align === "end" ? "right-0" : "left-0",
            menuClassName,
          )}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}
