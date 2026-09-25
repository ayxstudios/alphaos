"use client";

import Link from "next/link";
import { useEffect, useId, useState } from "react";

import { cn } from "@/lib/utils";
import { focusRing } from "@/components/ui/styles";
import { ArrowRight, ChevronDown } from "@/components/ui/icons";

const KEY = "home_fold_open";

function readOpen(): Record<string, boolean> {
  try {
    const raw = window.localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeOpen(id: string, open: boolean) {
  try {
    const all = readOpen();
    all[id] = open;
    window.localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // Private mode or blocked storage: the chart still opens, it just is not remembered.
  }
}

/**
 * A Home chart card that, on a phone, folds behind one line: the title, a
 * short summary and a chevron. A tap opens it, and the open state is
 * remembered per chart on this device. From md up it is the ordinary card,
 * always open, with no chevron. Folding hides, it never removes: the chart
 * is in the page either way.
 */
export function FoldSection({
  id,
  title,
  description,
  summary,
  action,
  always,
  quiet = false,
  className,
  children,
}: {
  /** Stable key for the remembered open state. */
  id: string;
  title: string;
  description?: string;
  /** The one line shown beside the title while folded (phone only). */
  summary?: string;
  action?: { label: string; href: string };
  /** Shown under the header even while folded (for example a link that needs a person). */
  always?: React.ReactNode;
  quiet?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  useEffect(() => {
    // Remembered state is read after mount, so the server render and the
    // first client render agree (both folded on a phone).
    if (readOpen()[id]) setOpen(true);
  }, [id]);

  function toggle() {
    const next = !open;
    setOpen(next);
    writeOpen(id, next);
  }

  return (
    <section className={cn("flex min-w-0 flex-col rounded-card bg-surface p-4 shadow-card sm:p-5 md:gap-4", open ? "gap-4" : "gap-0", className)}>
      {/* Phone header: the whole line is the button. */}
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-controls={bodyId}
        className={cn("-m-2 flex min-h-11 items-center gap-3 rounded-input p-2 text-left md:hidden", focusRing)}
      >
        <span className="min-w-0 flex-1">
          <span className={cn("block font-semibold text-ink", quiet ? "text-sm" : "text-base")}>{title}</span>
          <span className="block truncate text-xs text-slate">{open ? description : (summary ?? description)}</span>
        </span>
        <ChevronDown size={18} className={cn("shrink-0 text-slate transition-transform duration-200", open && "rotate-180")} />
      </button>

      {/* From md up: the ordinary card header. */}
      <div className="hidden items-start justify-between gap-3 md:flex">
        <div className="min-w-0">
          <h2 className={cn("font-semibold text-ink", quiet ? "text-sm" : "text-base")}>{title}</h2>
          {description && <p className={cn("mt-0.5 text-slate", quiet ? "text-xs" : "text-sm")}>{description}</p>}
        </div>
        {action && <ActionLink action={action} />}
      </div>


      <div id={bodyId} className={cn("min-w-0 flex-col gap-4 md:flex", open ? "flex" : "hidden")}>
        {children}
        {action && (
          <div className="md:hidden">
            <ActionLink action={action} />
          </div>
        )}
      </div>
      {/* After the body, as before: while folded on a phone it sits right under the header. */}
      {always && <div className={cn("min-w-0", !open && "max-md:mt-3")}>{always}</div>}
    </section>
  );
}

function ActionLink({ action }: { action: { label: string; href: string } }) {
  return (
    // -my-3 keeps the header's height while the link gets a 44px tap area on
    // touch screens (lg: back to the plain text link), same as HomeSection.
    <Link href={action.href} className="-my-3 inline-flex min-h-11 shrink-0 items-center gap-1 text-sm font-medium text-pigment hover:underline lg:my-0 lg:min-h-0">
      {action.label}
      <ArrowRight size={14} />
    </Link>
  );
}
