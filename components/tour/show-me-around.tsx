"use client";

import { useEffect } from "react";

import { cn } from "@/lib/utils";
import { focusRing } from "@/components/ui/styles";
import { ArrowRight } from "@/components/ui/icons";
import { startTour } from "@/lib/tour/request";

/** Plays the whole tour on its own: the Quick guide's main button. */
export function WatchButton({ className }: { className?: string }) {
  // Someone on the guide is about to press one of these: fetch the tour now.
  useEffect(() => {
    void import("./tour-runtime");
  }, []);
  return (
    <button
      type="button"
      data-tour-warm=""
      onClick={() => startTour({ mode: "watch" })}
      className={cn(
        "inline-flex min-h-11 items-center gap-2 rounded-input bg-pigment px-4 text-sm font-medium text-surface transition-opacity motion-hover hover:opacity-90 lg:min-h-10",
        focusRing,
        className,
      )}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M7 4.5v15l12-7.5z" />
      </svg>
      Watch how it works
    </button>
  );
}

/** Plays one step's demonstration, then lets the person try it. */
export function ShowMeButton({ step, title }: { step: number; title: string }) {
  return (
    <button
      type="button"
      data-tour-warm=""
      onClick={() => startTour({ mode: "one", step })}
      aria-label={`Show me: ${title}`}
      className={cn(
        "inline-flex min-h-11 shrink-0 items-center gap-1 rounded-input px-2 text-sm font-medium text-pigment transition-colors motion-hover hover:text-ink lg:min-h-9",
        focusRing,
      )}
    >
      Show me <ArrowRight size={14} />
    </button>
  );
}
