"use client";

import { cn } from "@/lib/utils";
import { Check, X } from "@/components/ui/icons";
import { shortcutFor, splitChecklistLabel, type ChecklistItem, type ItemResults } from "@/lib/qc/checklist";

/**
 * The QC checklist. Tap a line to tick it (it looks right), or the cross to
 * mark it wrong. Every item must be ticked before Pass is enabled. Keys 1-9
 * (0 for a tenth) toggle a line on a laptop; the ? legend lists them.
 */
export function ChecklistPanel({
  items,
  checked,
  onToggle,
  onMark,
  onTickAll,
  disabled = false,
}: {
  items: ChecklistItem[];
  checked: ItemResults;
  onToggle: (key: number) => void;
  /** true = looks right, false = wrong, null = not checked yet. */
  onMark: (key: number, value: boolean | null) => void;
  onTickAll: () => void;
  disabled?: boolean;
}) {
  const doneCount = items.filter((it) => checked[it.key]).length;
  const allDone = doneCount === items.length;

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 pb-2">
        <h2 className="font-display text-base font-semibold text-ink">
          Does it match?
          <span className="ml-2 text-sm font-normal tabular-nums text-slate">
            {doneCount} of {items.length}
          </span>
        </h2>
        <button
          type="button"
          onClick={onTickAll}
          disabled={disabled || allDone}
          className={cn(
            "inline-flex min-h-11 items-center rounded-input px-3 text-sm font-medium text-pigment transition-colors motion-hover",
            "hover:bg-pigment-soft disabled:pointer-events-none disabled:opacity-40",
          )}
        >
          Tick all
        </button>
      </div>

      <ul className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto pr-1">
        {items.map((it) => {
          const isChecked = checked[it.key] === true;
          const isFailed = checked[it.key] === false;
          const { name, hint } = splitChecklistLabel(it.label);
          return (
            <li key={it.key}>
              <div
                className={cn(
                  "flex w-full items-stretch gap-1 rounded-input transition-colors",
                  isChecked ? "bg-sage/10" : isFailed ? "bg-rose/10" : "bg-canvas/70",
                )}
              >
                <button
                  type="button"
                  onClick={() => onToggle(it.key)}
                  disabled={disabled}
                  aria-label={`${name}: ${isChecked ? "looks right" : isFailed ? "marked wrong" : "not checked"}. Tap to ${isChecked ? "untick" : "tick"}.`}
                  aria-pressed={isChecked}
                  className={cn(
                    "flex min-h-11 flex-1 items-start gap-2.5 rounded-input p-2.5 text-left transition-colors motion-hover",
                    "disabled:cursor-not-allowed disabled:opacity-60",
                    !isChecked && !isFailed && "hover:bg-canvas",
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded border",
                      isChecked
                        ? "border-sage bg-sage text-surface"
                        : isFailed
                          ? "border-rose bg-rose text-surface"
                          : "border-slate/40 bg-surface",
                    )}
                  >
                    {isChecked ? <Check size={13} /> : isFailed ? <X size={13} /> : null}
                  </span>
                  <span className="flex-1 text-sm leading-snug text-ink">
                    <span className="font-semibold">{name}</span>
                    {hint && <span className="block text-slate">{hint}</span>}
                  </span>
                  <kbd className="hidden self-center rounded border border-line bg-surface px-1.5 text-xs tabular-nums text-slate lg:inline">
                    {shortcutFor(it.key)}
                  </kbd>
                </button>
                <button
                  type="button"
                  onClick={() => onMark(it.key, isFailed ? null : false)}
                  disabled={disabled}
                  aria-pressed={isFailed}
                  aria-label={isFailed ? `${name}: undo wrong` : `${name}: mark wrong`}
                  title="Wrong"
                  className={cn(
                    "m-1 inline-flex size-11 shrink-0 items-center justify-center self-center rounded-input border transition-colors motion-hover",
                    "disabled:cursor-not-allowed disabled:opacity-60",
                    isFailed
                      ? "border-rose bg-rose text-surface"
                      : "border-line bg-surface text-slate hover:bg-rose/10 hover:text-rose",
                  )}
                >
                  <X size={16} />
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
