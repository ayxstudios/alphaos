"use client";

import { cn } from "@/lib/utils";
import { focusRing } from "@/components/ui/styles";
import { X } from "@/components/ui/icons";

const SHORTCUTS: { keys: string; action: string }[] = [
  { keys: "1-9, 0", action: "Tick or untick a line" },
  { keys: "A", action: "Tick all" },
  { keys: "Enter", action: "Pass (when all are ticked)" },
  { keys: "F", action: "Fail" },
  { keys: "J / K", action: "Next / previous order" },
  { keys: "?", action: "Show or hide this list" },
];

/** Dismissible shortcut legend, re-openable with `?`. Laptop and up only (it would cover the phone tab bar). */
export function ShortcutLegend({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return (
    <div className="fixed bottom-4 left-4 z-40 hidden w-64 rounded-card lg:block bg-surface p-3 shadow-lg [animation:alpha-toast-in_220ms_var(--ease-standard)]">
      <div className="flex items-center justify-between pb-2">
        <span className="font-display text-sm font-semibold text-ink">Keyboard shortcuts</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Dismiss shortcuts"
          className={cn(
            "inline-flex size-6 items-center justify-center rounded-input text-slate",
            "transition-colors motion-hover hover:bg-canvas hover:text-ink",
            focusRing,
          )}
        >
          <X size={14} />
        </button>
      </div>
      <dl className="flex flex-col gap-1.5">
        {SHORTCUTS.map((s) => (
          <div key={s.keys} className="flex items-center justify-between gap-2">
            <dt className="text-xs text-slate">{s.action}</dt>
            <dd>
              <kbd className="rounded border border-line bg-canvas px-1.5 py-0.5 text-xs font-medium tabular-nums text-ink">
                {s.keys}
              </kbd>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** Small floating "?" button to reopen the legend once dismissed. */
export function LegendToggle({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Show keyboard shortcuts"
      className={cn(
        // Keyboard shortcuts only matter with a keyboard: on a phone this would sit
        // on top of the bottom tab bar (the Home tab), so it shows from lg up.
        "fixed bottom-4 left-4 z-40 hidden size-9 items-center justify-center rounded-full lg:inline-flex",
        "border border-line bg-surface text-sm font-semibold text-slate shadow-md",
        "transition-colors motion-hover hover:text-ink",
        focusRing,
      )}
    >
      ?
    </button>
  );
}
