"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";

import type { Role } from "@/lib/auth/config";
import { tourOpening, type OnboardingState } from "@/lib/tour/state";
import { TOUR_START_EVENT, type TourRequest, type TourStartDetail } from "@/lib/tour/request";

/** Fired by the "?" menu and the Quick guide to start the tour (detail: TourStartDetail). */
export { TOUR_START_EVENT };

// The tour's code is only fetched when it is needed: on a first sign-in, or
// when someone asks for it. Hovering the "?" button warms it up.
const loadRuntime = () => import("./tour-runtime");
const TourRuntime = dynamic(loadRuntime, { ssr: false, loading: () => null });

export function Tour({
  role,
  firstName,
  onboarding,
  signedInAt,
}: {
  role: Role;
  firstName: string;
  onboarding: OnboardingState | null;
  signedInAt: number;
}) {
  const nextId = useRef(1);
  // Warmed up (the pointer is on "?"): mount the runtime idle, so a start is instant.
  const [warm, setWarm] = useState(false);
  const [request, setRequest] = useState<TourRequest | null>(() => {
    const open = tourOpening(onboarding, signedInAt);
    if (open.kind === "welcome") return { id: 0, kind: "welcome" };
    if (open.kind === "resume") return { id: 0, kind: "resume", step: open.step };
    return null;
  });

  useEffect(() => {
    const onStart = (e: Event) => {
      const detail = (e as CustomEvent<TourStartDetail>).detail ?? {};
      setRequest({ id: nextId.current++, kind: "start", mode: detail.mode ?? "try", step: detail.step ?? 0, at: performance.now() });
    };
    let warmed = false;
    const onWarm = (e: Event) => {
      if (warmed || !(e.target instanceof Element) || !e.target.closest('[data-tour="help"], [data-tour-warm]')) return;
      warmed = true;
      void loadRuntime().then(() => setWarm(true));
    };
    window.addEventListener(TOUR_START_EVENT, onStart);
    document.addEventListener("pointerover", onWarm, { passive: true });
    document.addEventListener("focusin", onWarm);
    return () => {
      window.removeEventListener(TOUR_START_EVENT, onStart);
      document.removeEventListener("pointerover", onWarm);
      document.removeEventListener("focusin", onWarm);
    };
  }, []);

  if (!request && !warm) return null;
  return <TourRuntime role={role} firstName={firstName} request={request} />;
}
