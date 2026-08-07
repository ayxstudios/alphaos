"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/utils";
import { Info } from "./icons";
import { focusRing } from "./styles";

const PANEL_WIDTH = 264;

/**
 * A small "?" help affordance. The panel is rendered in a portal on `document.body`
 * and positioned with fixed coordinates, so — unlike an absolutely-positioned
 * dropdown — it is never clipped by an `overflow` ancestor (e.g. a scrolling table).
 * Toggles on click; closes on outside-click, Escape, or scroll/resize.
 */
export function InfoBubble({
  label = "What does this mean?",
  className,
  children,
}: {
  label?: string;
  className?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const r = triggerRef.current.getBoundingClientRect();
    const margin = 8;
    const left = Math.max(
      margin,
      Math.min(r.left + r.width / 2 - PANEL_WIDTH / 2, window.innerWidth - PANEL_WIDTH - margin),
    );
    setCoords({ top: r.bottom + 6, left });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const dismiss = () => setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    // Capture scroll on any ancestor (the table scroller) so the panel follows nothing —
    // it just closes, which is simpler and never leaves it floating in the wrong place.
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
    };
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          setOpen((o) => !o);
        }}
        className={cn(
          "inline-flex size-5 shrink-0 items-center justify-center rounded-full text-slate transition-colors hover:bg-pigment-soft hover:text-pigment",
          open && "bg-pigment-soft text-pigment",
          focusRing,
          className,
        )}
      >
        <Info size={14} />
      </button>
      {open &&
        coords &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={panelRef}
            role="tooltip"
            style={{ position: "fixed", top: coords.top, left: coords.left, width: PANEL_WIDTH }}
            className="z-[100] rounded-card border border-line bg-surface p-3 text-sm text-ink shadow-lg [animation:alpha-toast-in_160ms_var(--ease-standard)]"
          >
            {children}
          </div>,
          document.body,
        )}
    </>
  );
}
