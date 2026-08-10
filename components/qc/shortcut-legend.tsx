"use client";

import { cn } from "@/lib/utils";
import { focusRing } from "@/components/ui/styles";
import { X } from "@/components/ui/icons";

const SHORTCUTS: { keys: string; action: string }[] = [
  { keys: "1–9, 0", action: "Toggle checklist item" },
  { keys: "A", action: "Tick all items" },
  { keys: "Enter", action: "Pass (when all ticked)" },
  { keys: "F", action: "Fail" },
  { keys: "J / K", action: "Next / previous order" },
  { keys: "?", action: "Toggle this legend" },
];

/** Dismissible shortcut legend, re-openable with `?`. */
export function ShortcutLegend({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return (
    <div className="fixed bottom-4 left-4 z-40 w-64 rounded-card border border-line bg-surface p-3 shadow-lg [animation:alpha-toast-in_220ms_var(--ease-standard)]">
      <div className="flex items-center justify-between pb-2">
        <span className="font-display text-sm text-ink">Keyboard shortcuts</span>
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
              <kbd className="rounded border border-line bg-canvas px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-ink">
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
        "fixed bottom-4 left-4 z-40 inline-flex size-9 items-center justify-center rounded-full",
        "border border-line bg-surface text-sm font-semibold text-slate shadow-md",
        "transition-colors motion-hover hover:text-ink",
        focusRing,
      )}
    >
      ?
    </button>
  );
}
