"use client";

import { useEffect, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";
import { PrefetchKind } from "next/dist/client/components/router-reducer/router-reducer-types";
import type { Role } from "@/lib/auth/config";
import { mainNavHrefs } from "./sidebar";

// Tab changes feel instant (Yousif 2026-10-01: "faster when changing tabs",
// "All Orders should just appear"). Once the current page has settled, the
// browser fetches every main menu page (page data included) in the background,
// one at a time, so the next click paints from the router cache (staleTimes
// 180 s, next.config.ts) with no round trip to iad1 (docs/PERF.md). The pages
// are fetched again every 2.5 minutes (inside that 3 minute window, so the
// cache never goes cold under a user who is working), after each navigation,
// and when the window regains focus or the tab comes back into view. Nothing
// runs in a hidden tab. Skipped on Data Saver / 2G.
const FULL = { kind: PrefetchKind.FULL };
const MIN_GAP_MS = 20_000;
const REWARM_MS = 150_000;
const SETTLE_MS = 1_200;
const STAGGER_MS = 250;

type NetInfo = { saveData?: boolean; effectiveType?: string };

export function IdlePrefetch({ role }: { role: Role }) {
  const router = useRouter();
  const pathname = usePathname();
  const last = useRef(0);

  useEffect(() => {
    const conn = (navigator as Navigator & { connection?: NetInfo }).connection;
    if (conn?.saveData || /(^|-)2g$/.test(conn?.effectiveType ?? "")) return;

    const timers: ReturnType<typeof setTimeout>[] = [];
    let idleId: number | undefined;
    const run = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - last.current < MIN_GAP_MS) return;
      last.current = Date.now();
      mainNavHrefs(role)
        .filter((href) => href !== pathname)
        .forEach((href, i) => timers.push(setTimeout(() => router.prefetch(href, FULL), i * STAGGER_MS)));
    };
    const schedule = () => {
      const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
      timers.push(
        setTimeout(() => {
          if (w.requestIdleCallback) idleId = w.requestIdleCallback(run, { timeout: 2_000 });
          else run();
        }, SETTLE_MS),
      );
    };
    schedule();
    const onVisible = () => document.visibilityState === "visible" && schedule();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    const rewarm = setInterval(() => {
      // Past the re-warm age, regardless of the short gap guard in run().
      last.current = Math.min(last.current, Date.now() - MIN_GAP_MS);
      onVisible();
    }, REWARM_MS);
    return () => {
      clearInterval(rewarm);
      window.removeEventListener("focus", onVisible);
      timers.forEach(clearTimeout);
      const w = window as Window & { cancelIdleCallback?: (id: number) => void };
      if (idleId !== undefined) w.cancelIdleCallback?.(idleId);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [role, pathname, router]);

  return null;
}
