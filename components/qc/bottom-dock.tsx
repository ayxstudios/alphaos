"use client";

import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

/**
 * Action bar docked to the very bottom edge of the screen (Yousif 2026-10-14:
 * "put the buttons on the very bottom for me to press, not hovering in the
 * middle of the screen"). Phone: fixed to the bottom edge, over the tab bar
 * (the menu button in the top bar still opens every page). lg and up: the
 * bottom edge of the content column (AppShell's column is `relative`), so it
 * stays right of the sidebar at either width.
 *
 * Out of flow, so: the spacer keeps the end of the page scrollable clear of
 * the dock, and `--dock-h` on <html> lets toasts and the Stop stack sit above it.
 */
export function BottomDock({ children, className }: { children: React.ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [spacer, setSpacer] = useState<number | null>(null);

  useEffect(() => {
    const dock = ref.current;
    if (!dock) return;
    const root = document.documentElement;
    const main = dock.closest("main");
    const measure = () => {
      // Leave main's scrollbar uncovered (0 on phones and overlay scrollbars).
      if (main) dock.style.right = `${main.offsetWidth - main.clientWidth}px`;
      const h = Math.ceil(dock.getBoundingClientRect().height);
      root.style.setProperty("--dock-h", `${h}px`);
      // main's own bottom padding already clears part of it.
      const pb = main ? parseFloat(getComputedStyle(main).paddingBottom) || 0 : 0;
      setSpacer(Math.max(0, h - Math.floor(pb)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(dock);
    if (main) ro.observe(main);
    return () => {
      ro.disconnect();
      root.style.removeProperty("--dock-h");
    };
  }, []);

  return (
    <>
      <div
        aria-hidden
        className={cn("shrink-0", spacer === null && "h-[env(safe-area-inset-bottom)] lg:h-10")}
        style={spacer === null ? undefined : { height: spacer }}
      />
      <div
        ref={ref}
        data-testid="bottom-dock"
        className="fixed inset-x-0 bottom-0 z-40 max-h-[85dvh] overflow-y-auto border-t border-line bg-surface px-4 pb-[env(safe-area-inset-bottom)] sm:px-6 lg:absolute lg:px-8"
      >
        <div className={cn("mx-auto flex max-w-5xl flex-col gap-3 py-3", className)}>{children}</div>
      </div>
    </>
  );
}
