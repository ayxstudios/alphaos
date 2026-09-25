"use client";

import { useEffect } from "react";

import { cn } from "@/lib/utils";
import { focusRing } from "@/components/ui/styles";
import { ArrowRight, Compass } from "@/components/ui/icons";
import { startTour } from "@/lib/tour/request";

/** Starts the guided tour (it points, the person clicks): the Quick guide's main button. */
export function ShowMeAroundButton({ className }: { className?: string }) {
  // Someone on the guide is about to press one of these: fetch the tour now.
  useEffect(() => {
    void import("./tour-runtime");
  }, []);
  return (
    <button
      type="button"
      data-tour-warm=""
      onClick={() => startTour({ mode: "try" })}
      className={cn(
        "inline-flex min-h-11 items-center gap-2 rounded-input bg-pigment px-4 text-sm font-medium text-surface transition-opacity motion-hover hover:opacity-90 lg:min-h-10",
        focusRing,
        className,
      )}
    >
      <Compass size={16} />
      Show me around
    </button>
  );
}

/** Opens one step's page with that step lit; the person does it. */
export function PointMeButton({ step, title }: { step: number; title: string }) {
  return (
    <button
      type="button"
      data-tour-warm=""
      onClick={() => startTour({ mode: "one", step })}
      aria-label={`Point me to it: ${title}`}
      className={cn(
        "inline-flex min-h-11 shrink-0 items-center gap-1 rounded-input px-2 text-sm font-medium text-pigment transition-colors motion-hover hover:text-ink lg:min-h-9",
        focusRing,
      )}
    >
      Point me to it <ArrowRight size={14} />
    </button>
  );
}
