"use client";

import { useEffect } from "react";

const COOKIE = "orders_view";

export function OrdersViewPreference({ view }: { view: string }) {
  useEffect(() => {
    document.cookie = `${COOKIE}=${encodeURIComponent(view)}; path=/; max-age=31536000; samesite=lax`;
  }, [view]);

  // On a phone the view pills scroll sideways: bring the open view fully into
  // sight instead of leaving it half off the edge.
  useEffect(() => {
    const row = document.querySelector<HTMLElement>("[data-orders-views]");
    const active = row?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!row || !active || row.scrollWidth <= row.clientWidth) return;
    const left = active.getBoundingClientRect().left - row.getBoundingClientRect().left + row.scrollLeft;
    const right = left + active.offsetWidth;
    if (left < row.scrollLeft || right > row.scrollLeft + row.clientWidth) {
      row.scrollLeft = Math.max(0, right - row.clientWidth + 16);
    }
  }, [view]);

  return null;
}
