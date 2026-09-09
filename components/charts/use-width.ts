"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Pixel width of a container, kept fresh with ResizeObserver. Every chart
 * draws in real pixels (no `preserveAspectRatio="none"` stretching), so text,
 * markers and gaps keep their true size at any width, phone included.
 */
export function useWidth<T extends HTMLElement>(fallback = 320) {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w && Math.abs(w - width) > 0.5) setWidth(w);
    });
    ro.observe(el);
    setWidth(el.getBoundingClientRect().width || fallback);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return { ref, width };
}

export const CHART = {
  c1: "var(--color-chart-1)",
  c2: "var(--color-chart-2)",
  c3: "var(--color-chart-3)",
  c4: "var(--color-chart-4)",
  c5: "var(--color-chart-5)",
  muted: "var(--color-chart-muted)",
  track: "var(--color-chart-track)",
  ink: "var(--color-ink)",
  slate: "var(--color-slate)",
  line: "var(--color-line)",
  surface: "var(--color-surface)",
} as const;

export type ChartColor = keyof typeof CHART;
