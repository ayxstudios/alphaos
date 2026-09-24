"use client";

import { useEffect } from "react";

const COOKIE = "orders_view";

export function OrdersViewPreference({ view, syncUrl }: { view: string; syncUrl?: string | null }) {
  useEffect(() => {
    document.cookie = `${COOKIE}=${encodeURIComponent(view)}; path=/; max-age=31536000; samesite=lax`;
  }, [view]);

  // /orders with no ?view rendered its fallback view in place (no redirect):
  // put the view in the address bar so a reload, a share or the view pills
  // (aria-current) agree with what is on screen. Next's router follows a
  // native replaceState (null state, so it keeps its own entry data), and
  // nothing is fetched.
  useEffect(() => {
    if (!syncUrl) return;
    if (location.pathname + location.search === syncUrl) return;
    window.history.replaceState(null, "", syncUrl);
  }, [syncUrl]);

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
