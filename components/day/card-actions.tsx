"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button, Textarea, useToast } from "@/components/ui";
import { cn } from "@/lib/utils";
import { tourIsRunning } from "@/lib/tour/live";
import { splitChecklistLabel, type ChecklistItem } from "@/lib/qc/checklist";
import {
  approvePrintAction,
  approveQcAction,
  bouncePrintAction,
  bounceQcAction,
  type DayResult,
} from "@/app/(app)/day/actions";

type Kind = "portrait" | "revision" | "print";

/**
 * Approve (green, full width on a phone) and Bounce (needs a note) for one
 * Day card. Portrait and revision cards also ask what is wrong, because the
 * QC fail the bounce reuses needs at least one failed check.
 */
export function DayCardActions({
  orderId,
  kind,
  checklist,
  approveDisabledReason,
}: {
  orderId: string;
  kind: Kind;
  checklist: ChecklistItem[];
  approveDisabledReason?: string | null;
}) {
  const router = useRouter();
  const toast = useToast();
  const [bouncing, setBouncing] = useState(false);
  const [note, setNote] = useState("");
  const [wrong, setWrong] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [which, setWhich] = useState<"approve" | "bounce" | null>(null);

  function finish(res: DayResult) {
    if (res.ok) {
      toast({ variant: "success", title: res.message });
    } else {
      setError(res.message);
      toast({ variant: "danger", title: res.message });
    }
    router.refresh();
  }

  function approve() {
    setError(null);
    if (tourIsRunning()) return toast({ variant: "success", title: "That approves it. Nothing was sent in the tour." });
    setWhich("approve");
    start(async () => finish(kind === "print" ? await approvePrintAction(orderId) : await approveQcAction(orderId)));
  }

  function bounce() {
    setError(null);
    if (tourIsRunning()) return toast({ variant: "success", title: "That sends it back. Nothing was sent in the tour." });
    if (!note.trim()) return setError("Write a note for the designer first.");
    if (kind !== "print" && wrong.length === 0) return setError("Tick what is wrong first.");
    setWhich("bounce");
    start(async () => finish(kind === "print" ? await bouncePrintAction(orderId, note) : await bounceQcAction(orderId, note, wrong)));
  }

  return (
    <div className="flex flex-col gap-3">
      {bouncing && (
        <div className="flex flex-col gap-3 rounded-lg bg-canvas p-3">
          {kind !== "print" && (
            <fieldset className="flex flex-col gap-1">
              <legend className="mb-1 text-sm font-medium text-ink">What is wrong?</legend>
              {checklist.map((it) => {
                const on = wrong.includes(it.key);
                return (
                  <label
                    key={it.key}
                    className={cn(
                      "flex min-h-11 cursor-pointer items-center gap-3 rounded-md border px-3 text-sm",
                      on ? "border-rose/40 bg-rose/10 text-ink" : "border-line bg-surface text-slate",
                    )}
                  >
                    <input
                      type="checkbox"
                      className="size-5 accent-rose"
                      checked={on}
                      onChange={() => setWrong((w) => (on ? w.filter((k) => k !== it.key) : [...w, it.key]))}
                    />
                    {splitChecklistLabel(it.label).name}
                  </label>
                );
              })}
            </fieldset>
          )}
          <Textarea
            label="Note for the designer (required)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            maxLength={1000}
            placeholder="What needs to change"
          />
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button type="button" variant="danger" className="min-h-11 w-full sm:w-auto" loading={pending && which === "bounce"} disabled={pending} onClick={bounce}>
              Send back to designer
            </Button>
            <Button type="button" variant="secondary" className="min-h-11 w-full sm:w-auto" disabled={pending} onClick={() => setBouncing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-rose">
          {error}
        </p>
      )}
      {approveDisabledReason && <p className="text-sm text-amber">{approveDisabledReason}</p>}
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button
          type="button"
          size="lg"
          className="min-h-11 w-full bg-sage text-surface sm:flex-1"
          loading={pending && which === "approve"}
          disabled={pending || !!approveDisabledReason}
          onClick={approve}
        >
          {kind === "print" ? "Approve and send to print" : "Approve and send to buyer"}
        </Button>
        {!bouncing && (
          <Button type="button" size="lg" variant="secondary" className="min-h-11 w-full sm:w-auto" disabled={pending} onClick={() => setBouncing(true)}>
            Bounce
          </Button>
        )}
      </div>
    </div>
  );
}
