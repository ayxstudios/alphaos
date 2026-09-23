"use client";

import { useEffect } from "react";

/**
 * Registers public/sw.js (static build files cache, docs/PERF.md) once the
 * page is idle, in production builds only. The build id in the URL makes each
 * deploy a new worker that clears the old cache. Renders nothing.
 */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;
    const register = () => {
      navigator.serviceWorker
        .register(`/sw.js?v=${encodeURIComponent(process.env.NEXT_PUBLIC_BUILD_ID ?? "dev")}`, { scope: "/" })
        .catch(() => {});
    };
    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });
  }, []);
  return null;
}
