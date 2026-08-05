"use client";

import { useEffect } from "react";

const COOKIE = "orders_view";

export function OrdersViewPreference({ view }: { view: string }) {
  useEffect(() => {
    document.cookie = `${COOKIE}=${encodeURIComponent(view)}; path=/; max-age=31536000; samesite=lax`;
  }, [view]);

  return null;
}
