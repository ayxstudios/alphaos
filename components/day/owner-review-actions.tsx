"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button, Textarea, useToast } from "@/components/ui";
import { tourIsRunning } from "@/lib/tour/live";
import { approveOwnerReviewAction, ownerNeedsFixAction, type DayResult } from "@/app/(app)/day/actions";

/** Approve (sends the held proof) and Needs a fix (back to the AI with a reason) for one owner-review card. */
export function OwnerReviewActions({ orderId }: { orderId: string }) {
  const router = useRouter();
  const toast = useToast();
  const [fixing, setFixing] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [which, setWhich] = useState<"ok" | "fix" | null>(null);
  const [pending, start] = useTransition();

  function finish(res: DayResult) {
    toast({ variant: res.ok ? "success" : "danger", title: res.message });
    if (!res.ok) setError(res.message);
    router.refresh();
  }

  function approve() {
    setError(null);
    if (tourIsRunning()) return toast({ variant: "success", title: "That approves it. Nothing was sent in the tour." });
    setWhich("ok");
    start(async () => finish(await approveOwnerReviewAction(orderId)));
  }

  function fix() {
    setError(null);
    if (tourIsRunning()) return toast({ variant: "success", title: "That sends it back. Nothing was sent in the tour." });
    if (!note.trim()) return setError("Say what needs fixing first.");
    setWhich("fix");
    start(async () => finish(await ownerNeedsFixAction(orderId, note)));
  }

  return (
    <div className="flex flex-col gap-3">
      {fixing && (
        <div className="flex flex-col gap-2 rounded-lg bg-canvas p-3">
          <Textarea label="What needs fixing? (the AI reads this)" value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={1000} placeholder="e.g. The eyes are too dark" />
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button type="button" variant="danger" className="min-h-11 w-full sm:w-auto" loading={pending && which === "fix"} disabled={pending} onClick={fix}>
              Send back to the AI
            </Button>
            <Button type="button" variant="secondary" className="min-h-11 w-full sm:w-auto" disabled={pending} onClick={() => setFixing(false)}>
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
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button type="button" size="lg" className="min-h-11 w-full bg-sage text-surface sm:flex-1" loading={pending && which === "ok"} disabled={pending} onClick={approve}>
          Approve and send to buyer
        </Button>
        {!fixing && (
          <Button type="button" size="lg" variant="secondary" className="min-h-11 w-full sm:w-auto" disabled={pending} onClick={() => setFixing(true)}>
            Needs a fix
          </Button>
        )}
      </div>
    </div>
  );
}
