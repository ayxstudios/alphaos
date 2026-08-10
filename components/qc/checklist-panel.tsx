"use client";

import { cn } from "@/lib/utils";
import { Check, X } from "@/components/ui/icons";
import { shortcutFor, type ChecklistItem, type ItemResults } from "@/lib/qc/checklist";

/**
 * The QC checklist. Every item must be explicitly ticked before Pass is enabled.
 * Each row shows its keyboard shortcut (1–9, 0 for the tenth).
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
  onMark: (key: number, value: boolean) => void;
  onTickAll: () => void;
  disabled?: boolean;
}) {
  const doneCount = items.filter((it) => checked[it.key]).length;
  const failedCount = items.filter((it) => checked[it.key] === false).length;
  const allDone = doneCount === items.length;
  const reviewedPct = items.length ? (doneCount / items.length) * 100 : 0;
  const failedPct = items.length ? (failedCount / items.length) * 100 : 0;

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 pb-2.5">
        <h2 className="font-display text-sm text-ink">
          Checklist
          <span className="ml-2 text-xs font-normal tabular-nums text-slate">
            {doneCount}/{items.length}
            {failedCount > 0 ? ` · ${failedCount} failed` : ""}
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

      {/* Reviewed-so-far meter: sage = passed, rose = failed, remainder untouched. */}
      <div
        className="mb-3 flex h-1.5 shrink-0 overflow-hidden rounded-full bg-line/70"
        role="progressbar"
        aria-label="Checklist progress"
        aria-valuenow={doneCount + failedCount}
        aria-valuemin={0}
        aria-valuemax={items.length}
      >
        <div className="h-full bg-sage transition-[width] duration-300" style={{ width: `${reviewedPct}%` }} />
        <div className="h-full bg-rose transition-[width] duration-300" style={{ width: `${failedPct}%` }} />
      </div>

      <ul className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto pr-1">
        {items.map((it) => {
          const isChecked = checked[it.key] === true;
          const isFailed = checked[it.key] === false;
          return (
            <li key={it.key}>
              <div
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-input border p-2 text-left transition-colors",
                  isChecked
                    ? "border-sage/30 bg-sage/[0.07]"
                    : isFailed
                      ? "border-rose/30 bg-rose/[0.07]"
                      : "border-line bg-surface hover:border-slate/40 hover:bg-canvas",
                )}
              >
                {/* Doubles as the keyboard-shortcut hint (idle) and the toggle
                    control — shows the number, then the resolved state. */}
                <button
                  type="button"
                  onClick={() => onToggle(it.key)}
                  disabled={disabled}
                  aria-label={`Toggle ${it.label}`}
                  className={cn(
                    "flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold tabular-nums transition-colors",
                    isChecked
                      ? "border-sage bg-sage text-surface"
                      : isFailed
                        ? "border-rose bg-rose text-surface"
                        : "border-line bg-canvas text-slate",
                  )}
                >
                  {isChecked ? <Check size={13} /> : isFailed ? <X size={13} /> : shortcutFor(it.key)}
                </button>
                <span className="flex-1 text-sm leading-snug text-ink">{it.label}</span>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => onMark(it.key, true)}
                    disabled={disabled}
                    aria-pressed={isChecked}
                    aria-label={`Mark "${it.label}" passed`}
                    className={cn(
                      "inline-flex size-7 items-center justify-center rounded border text-xs transition-colors",
                      isChecked
                        ? "border-sage bg-sage text-surface"
                        : "border-line bg-surface text-slate hover:bg-sage/10 hover:text-sage",
                    )}
                  >
                    <Check size={13} />
                  </button>
                  <button
                    type="button"
                    onClick={() => onMark(it.key, false)}
                    disabled={disabled}
                    aria-pressed={isFailed}
                    aria-label={`Mark "${it.label}" failed`}
                    className={cn(
                      "inline-flex size-7 items-center justify-center rounded border text-xs transition-colors",
                      isFailed
                        ? "border-rose bg-rose text-surface"
                        : "border-line bg-surface text-slate hover:bg-rose/10 hover:text-rose",
                    )}
                  >
                    <X size={13} />
                  </button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
