"use client";

import { useEffect, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";
import { PrefetchKind } from "next/dist/client/components/router-reducer/router-reducer-types";
import type { Role } from "@/lib/auth/config";
import { mainNavHrefs } from "./sidebar";

// Tab changes feel instant (Yousif 2026-10-01: "faster when changing tabs").
// Once the current page has settled, the browser fetches every main menu page
// (page data included) in the background, one at a time, so the next click
// paints from the router cache (staleTimes 30 s, next.config.ts) instead of
// waiting on a round trip to iad1 (docs/PERF.md). It runs again after each
// navigation and when the tab comes back into view, at most once per 25 s,
// so the cache stays warm while someone is working and costs nothing while
// the app sits idle in a background tab. Skipped on Data Saver / 2G.
const FULL = { kind: PrefetchKind.FULL };
const MIN_GAP_MS = 25_000;
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
    return () => {
      timers.forEach(clearTimeout);
      const w = window as Window & { cancelIdleCallback?: (id: number) => void };
      if (idleId !== undefined) w.cancelIdleCallback?.(idleId);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [role, pathname, router]);

  return null;
}
