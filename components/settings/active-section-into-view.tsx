"use client";

import { useEffect } from "react";

/**
 * On a phone the Settings sections are one scrolling row. Bring the open
 * section into view so it is never cut off at the edge (only the row
 * scrolls sideways; the page itself does not move).
 */
export function ActiveSectionIntoView({ navId, active }: { navId: string; active: string }) {
  useEffect(() => {
    const nav = document.getElementById(navId);
    const link = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !link || nav.scrollWidth <= nav.clientWidth) return;
    const left = link.offsetLeft - (nav.clientWidth - link.offsetWidth) / 2;
    nav.scrollLeft = Math.max(0, left);
  }, [navId, active]);
  return null;
}
