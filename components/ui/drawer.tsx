"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/utils";
import { focusRing } from "./styles";
import { X } from "./icons";

export type DrawerProps = {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  className?: string;
};

export function Drawer({
  open,
  onClose,
  title,
  children,
  className,
}: DrawerProps) {
  const [mounted, setMounted] = useState(false);
  const [present, setPresent] = useState(open);
  const [visible, setVisible] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => setMounted(true), []);

  // Enter/exit lifecycle so the 220ms slide plays in both directions.
  useEffect(() => {
    if (open) {
      setPresent(true);
      const raf = requestAnimationFrame(() => setVisible(true));
      return () => cancelAnimationFrame(raf);
    }
    setVisible(false);
    const t = setTimeout(() => setPresent(false), 220);
    return () => clearTimeout(t);
  }, [open]);

  // ESC to close + body scroll lock while present.
  useEffect(() => {
    if (!present) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [present, onClose]);

  useEffect(() => {
    if (visible) closeRef.current?.focus();
  }, [visible]);

  if (!mounted || !present) return null;

  return createPortal(
    <div className="fixed inset-0 z-50" aria-hidden={!open}>
      {/* Overlay */}
      <div
        onClick={onClose}
        className={cn(
          "absolute inset-0 bg-ink/40 transition-opacity motion-layout",
          visible ? "opacity-100" : "opacity-0",
        )}
      />
      {/* Panel */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn(
          "absolute right-0 top-0 flex h-full w-full max-w-sm flex-col bg-surface shadow-lg",
          "transition-transform motion-layout",
          visible ? "translate-x-0" : "translate-x-full",
          className,
        )}
      >
        <div className="flex items-center justify-between border-b border-line p-4">
          <h2 className="font-display text-lg font-semibold text-ink">
            {title}
          </h2>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close"
            className={cn(
              "inline-flex size-8 items-center justify-center rounded-input text-slate",
              "transition-colors motion-hover hover:bg-canvas hover:text-ink",
              focusRing,
            )}
          >
            <X size={18} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
