"use client";

import { cn } from "@/lib/utils";
import { Check } from "@/components/ui/icons";
import { shortcutFor, type ChecklistItem, type ItemResults } from "@/lib/qc/checklist";

/**
 * The QC checklist. Every item must be explicitly ticked before Pass is enabled.
 * Each row shows its keyboard shortcut (1–9, 0 for the tenth).
 */
export function ChecklistPanel({
  items,
  checked,
  onToggle,
  onTickAll,
  disabled = false,
}: {
  items: ChecklistItem[];
  checked: ItemResults;
  onToggle: (key: number) => void;
  onTickAll: () => void;
  disabled?: boolean;
}) {
  const doneCount = items.filter((it) => checked[it.key]).length;
  const allDone = doneCount === items.length;

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 pb-2">
        <h2 className="font-display text-sm font-semibold text-ink">
          Checklist
          <span className="ml-2 text-xs font-normal tabular-nums text-slate">
            {doneCount}/{items.length}
          </span>
        </h2>
        <button
          type="button"
          onClick={onTickAll}
          disabled={disabled || allDone}
          className={cn(
            "rounded-input px-2 py-1 text-xs font-medium text-pigment transition-colors motion-hover",
            "hover:bg-pigment-soft disabled:pointer-events-none disabled:opacity-40",
          )}
        >
          Tick all{" "}
          <kbd className="rounded border border-line bg-canvas px-1 text-[10px] text-slate">A</kbd>
        </button>
      </div>

      <ul className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto pr-1">
        {items.map((it) => {
          const isChecked = checked[it.key] === true;
          return (
            <li key={it.key}>
              <button
                type="button"
                onClick={() => onToggle(it.key)}
                disabled={disabled}
                aria-pressed={isChecked}
                className={cn(
                  "flex w-full items-start gap-2.5 rounded-input border p-2.5 text-left transition-colors motion-hover",
                  "disabled:cursor-not-allowed disabled:opacity-60",
                  isChecked
                    ? "border-sage/30 bg-sage/10"
                    : "border-line bg-surface hover:border-slate/40 hover:bg-canvas",
                )}
              >
                <span
                  className={cn(
                    "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded border",
                    isChecked ? "border-sage bg-sage text-surface" : "border-slate/40 bg-surface",
                  )}
                >
                  {isChecked && <Check size={13} />}
                </span>
                <span className="flex-1 text-sm leading-snug text-ink">{it.label}</span>
                <kbd className="mt-0.5 shrink-0 rounded border border-line bg-canvas px-1.5 text-xs tabular-nums text-slate">
                  {shortcutFor(it.key)}
                </kbd>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
