"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/utils";
import { Button, Textarea } from "@/components/ui";
import { focusRing } from "@/components/ui/styles";
import { X } from "@/components/ui/icons";
import type { ChecklistItem } from "@/lib/qc/checklist";

/**
 * Fail flow: pick which items failed (at least one) and write a mandatory reason.
 * Unticked items are pre-selected as failures — the VA confirms or adjusts. On
 * submit the reason + failed items go back to the designer.
 */
export function FailDialog({
  open,
  onClose,
  items,
  initialFailedKeys,
  submitting,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  items: ChecklistItem[];
  initialFailedKeys: number[];
  submitting: boolean;
  onSubmit: (failedKeys: number[], reason: string) => void;
}) {
  const [mounted, setMounted] = useState(false);
  const [failed, setFailed] = useState<Set<number>>(new Set());
  const [reason, setReason] = useState("");
  const [touched, setTouched] = useState(false);
  const reasonRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => setMounted(true), []);

  // Reset each time the dialog opens.
  useEffect(() => {
    if (open) {
      setFailed(new Set(initialFailedKeys));
      setReason("");
      setTouched(false);
      const raf = requestAnimationFrame(() => reasonRef.current?.focus());
      return () => cancelAnimationFrame(raf);
    }
  }, [open, initialFailedKeys]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!mounted || !open) return null;

  function toggle(key: number) {
    setFailed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const reasonTrimmed = reason.trim();
  const canSubmit = failed.size > 0 && reasonTrimmed.length > 0 && !submitting;

  function submit() {
    setTouched(true);
    if (!canSubmit) return;
    onSubmit([...failed], reasonTrimmed);
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-ink/40" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Fail QC"
        className="relative flex max-h-[85vh] w-full max-w-lg flex-col rounded-modal border border-line bg-surface shadow-lg [animation:alpha-toast-in_220ms_var(--ease-standard)]"
      >
        <div className="flex items-center justify-between border-b border-line p-4">
          <div>
            <h2 className="font-display text-lg text-ink">Fail this portrait</h2>
            <p className="text-xs text-slate">
              Select what&apos;s wrong and tell the designer how to fix it.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className={cn(
              "inline-flex size-8 items-center justify-center rounded-input text-slate",
              "transition-colors motion-hover hover:bg-canvas hover:text-ink",
              focusRing,
            )}
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-ink">Failed items</span>
            <div className="flex flex-col gap-1">
              {items.map((it) => {
                const on = failed.has(it.key);
                return (
                  <button
                    key={it.key}
                    type="button"
                    onClick={() => toggle(it.key)}
                    aria-pressed={on}
                    className={cn(
                      "flex items-start gap-2 rounded-input border p-2 text-left text-sm transition-colors motion-hover",
                      on
                        ? "border-rose/40 bg-rose/10 text-ink"
                        : "border-line bg-surface text-slate hover:border-slate/40",
                    )}
                  >
                    <span
                      className={cn(
                        "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-sm border text-[10px]",
                        on ? "border-rose bg-rose text-surface" : "border-slate/40",
                      )}
                    >
                      {on ? "✕" : ""}
                    </span>
                    <span className="leading-snug">{it.label}</span>
                  </button>
                );
              })}
            </div>
            {touched && failed.size === 0 && (
              <p className="text-xs text-rose" role="alert">
                Select at least one failed item.
              </p>
            )}
          </div>

          <Textarea
            ref={reasonRef}
            label="Reason for the designer (required)"
            placeholder="Be specific: e.g. left eye should be green, ring on wrong hand…"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            error={touched && !reasonTrimmed ? "A reason is required." : undefined}
            rows={4}
          />
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-line p-4">
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="danger" onClick={submit} loading={submitting} disabled={!canSubmit}>
            Fail & return to designer
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
