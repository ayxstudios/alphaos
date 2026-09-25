"use client";

import { useEffect, useId, useState } from "react";

import { cn } from "@/lib/utils";
import { focusRing } from "./styles";

const DESKTOP = "(min-width: 1024px)";

/**
 * A section that starts folded on a phone and open from lg up. It looks like
 * Disclosure (a card with a summary row and a chevron) and toggles the same
 * way at every width. Folding hides, it never removes: the content is in the
 * page either way.
 *
 * Before hydration CSS decides (hidden below lg, shown from lg), so neither
 * width flashes. After mount the state takes over, and a link to an anchor
 * inside (`hashIds`, for example "#notes") opens it on a phone too.
 *
 * `plain` drops the card chrome, for a fold inside another card.
 * `staticFromLg` keeps the desktop exactly as it was: from lg up there is no
 * toggle row and the content always shows; only a phone folds.
 */
export function PhoneFold({
  summary,
  hint,
  hashIds = [],
  plain = false,
  staticFromLg = false,
  className,
  bodyClassName,
  children,
}: {
  summary: React.ReactNode;
  hint?: React.ReactNode;
  hashIds?: string[];
  plain?: boolean;
  staticFromLg?: boolean;
  className?: string;
  bodyClassName?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState<boolean | null>(null);
  const bodyId = useId();
  const hashKey = hashIds.join(",");

  useEffect(() => {
    const hash = window.location.hash.replace(/^#/, "");
    const wanted = !!hash && hashKey.split(",").includes(hash);
    setOpen(wanted || window.matchMedia(DESKTOP).matches);
  }, [hashKey]);

  const shown = cn(open === null ? "hidden lg:block" : open ? "block" : "hidden", staticFromLg && "lg:block");
  const turned = open === null ? "lg:rotate-90" : open ? "rotate-90" : "";

  return (
    <div className={cn(plain ? "" : "rounded-card bg-surface shadow-card", className)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !(o ?? window.matchMedia(DESKTOP).matches))}
        aria-expanded={open ?? false}
        aria-controls={bodyId}
        className={cn(
          "flex w-full min-h-11 cursor-pointer items-center justify-between gap-3 text-left text-sm font-medium text-ink",
          plain ? "rounded-input py-2" : "rounded-card px-4 py-3",
          staticFromLg && "lg:hidden",
          focusRing,
        )}
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="shrink-0">{summary}</span>
          {hint && <span className="min-w-0 truncate text-xs font-normal text-slate">{hint}</span>}
        </span>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={cn("shrink-0 text-slate transition-transform", turned)}>
          <path d="M9 6l6 6-6 6" />
        </svg>
      </button>
      <div id={bodyId} className={cn(shown, plain ? "" : "border-t border-line/70 px-4 py-3", plain || !staticFromLg ? "" : "lg:border-t-0 lg:p-4", bodyClassName)}>
        {children}
      </div>
    </div>
  );
}
