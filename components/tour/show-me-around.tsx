"use client";

import { cn } from "@/lib/utils";
import { focusRing } from "@/components/ui/styles";
import { Compass } from "@/components/ui/icons";
import { TOUR_START_EVENT } from "./tour";

/** Restarts the first-run tour from the Quick guide. */
export function ShowMeAroundButton({ className }: { className?: string }) {
  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new CustomEvent(TOUR_START_EVENT))}
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
