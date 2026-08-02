"use client";

import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui";
import { PROOF_ISSUES } from "@/lib/proofs/issues";
import type { ProofAnnotation } from "@/lib/db/schema";
import type { ProofDecision } from "@/lib/proofs/decide";
import { approveAction, revisionAction, trackView } from "./actions";

type Props = {
  token: string;
  orderNumber: string;
  hasPreview: boolean;
  actionable: boolean;
  initialDecision: ProofDecision | null;
};

type Mode = "idle" | "confirmApprove" | "revise";

export function ProofClient({
  token,
  orderNumber,
  hasPreview,
  actionable,
  initialDecision,
}: Props) {
  const [outcome, setOutcome] = useState<ProofDecision | null>(initialDecision);
  const [mode, setMode] = useState<Mode>("idle");
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [note, setNote] = useState("");
  const [pins, setPins] = useState<ProofAnnotation[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  // Log the view once, on mount. Fire-and-forget; failures are non-fatal.
  useEffect(() => {
    void trackView(token);
  }, [token]);

  function toggleIssue(key: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function addPin(e: React.MouseEvent<HTMLImageElement>) {
    if (mode !== "revise") return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    setPins((prev) => [...prev, { x, y }]);
  }

  async function onApprove() {
    setSubmitting(true);
    setError(null);
    const res = await approveAction(token);
    setSubmitting(false);
    if (res.ok) setOutcome("approved");
    else setError(res.message);
  }

  async function onRequestRevision() {
    setSubmitting(true);
    setError(null);
    const res = await revisionAction(token, {
      issueKeys: [...checked],
      note,
      annotations: pins,
    });
    setSubmitting(false);
    if (res.ok) setOutcome("revision");
    else setError(res.message);
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Preview -------------------------------------------------------- */}
      {hasPreview ? (
        <figure className="relative overflow-hidden rounded-card border border-line bg-canvas shadow-sm">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            ref={imgRef}
            src={`/api/proof/${token}/preview`}
            alt={`Portrait proof for order ${orderNumber}`}
            onClick={addPin}
            className={
              "block w-full select-none " +
              (mode === "revise" ? "cursor-crosshair" : "")
            }
            draggable={false}
          />
          {pins.map((p, i) => (
            <span
              key={i}
              className="pointer-events-none absolute flex size-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-pigment text-xs font-semibold text-surface shadow-md ring-2 ring-surface"
              style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }}
            >
              {i + 1}
            </span>
          ))}
        </figure>
      ) : (
        <div className="rounded-card border border-dashed border-line bg-surface p-8 text-center text-sm text-slate">
          Your proof is being prepared. Please check back shortly.
        </div>
      )}

      {/* Outcome (read-only once decided) ------------------------------ */}
      {outcome ? (
        <Confirmation decision={outcome} />
      ) : !actionable ? (
        <p className="rounded-card border border-line bg-surface p-4 text-center text-sm text-slate">
          This proof isn&rsquo;t awaiting your review right now.
        </p>
      ) : (
        <>
          {error && (
            <p className="rounded-input border border-rose/30 bg-rose/10 p-3 text-sm text-rose">
              {error}
            </p>
          )}

          {mode === "idle" && (
            <div className="flex flex-col gap-3">
              <Button size="lg" onClick={() => setMode("confirmApprove")}>
                Approve this portrait
              </Button>
              <Button
                size="lg"
                variant="secondary"
                onClick={() => setMode("revise")}
              >
                Request a change
              </Button>
            </div>
          )}

          {mode === "confirmApprove" && (
            <div className="flex flex-col gap-3 rounded-card border border-line bg-surface p-4">
              <p className="text-base text-ink">
                Happy with your portrait? Once you approve, we&rsquo;ll get it
                ready for you — no further changes after this.
              </p>
              <div className="flex flex-col gap-2 sm:flex-row-reverse">
                <Button
                  size="lg"
                  onClick={onApprove}
                  loading={submitting}
                  className="sm:flex-1"
                >
                  Yes, approve it
                </Button>
                <Button
                  size="lg"
                  variant="ghost"
                  onClick={() => setMode("idle")}
                  disabled={submitting}
                  className="sm:flex-1"
                >
                  Not yet
                </Button>
              </div>
            </div>
          )}

          {mode === "revise" && (
            <div className="flex flex-col gap-4 rounded-card border border-line bg-surface p-4">
              <div>
                <h2 className="text-lg font-semibold text-ink">
                  What would you like changed?
                </h2>
                <p className="mt-1 text-sm text-slate">
                  Pick anything that applies, add a note, and tap the image to
                  point at a spot.
                </p>
              </div>

              <fieldset className="flex flex-col gap-2">
                {PROOF_ISSUES.map((issue) => (
                  <label
                    key={issue.key}
                    className="flex cursor-pointer items-center gap-3 rounded-input border border-line px-3 py-2.5 text-sm text-ink has-[:checked]:border-pigment has-[:checked]:bg-pigment-soft motion-hover"
                  >
                    <input
                      type="checkbox"
                      checked={checked.has(issue.key)}
                      onChange={() => toggleIssue(issue.key)}
                      className="size-4 accent-pigment"
                    />
                    {issue.label}
                  </label>
                ))}
              </fieldset>

              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={4}
                maxLength={2000}
                placeholder="Add any details that will help us get it just right…"
                className="w-full rounded-input border border-line bg-canvas p-3 text-sm text-ink placeholder:text-slate focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pigment"
              />

              {pins.length > 0 && (
                <div className="flex items-center justify-between text-sm text-slate">
                  <span>
                    {pins.length} spot{pins.length === 1 ? "" : "s"} marked on the
                    image
                  </span>
                  <button
                    type="button"
                    onClick={() => setPins([])}
                    className="font-medium text-pigment underline-offset-2 hover:underline"
                  >
                    Clear pins
                  </button>
                </div>
              )}

              <div className="flex flex-col gap-2 sm:flex-row-reverse">
                <Button
                  size="lg"
                  onClick={onRequestRevision}
                  loading={submitting}
                  className="sm:flex-1"
                >
                  Send my request
                </Button>
                <Button
                  size="lg"
                  variant="ghost"
                  onClick={() => setMode("idle")}
                  disabled={submitting}
                  className="sm:flex-1"
                >
                  Back
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Confirmation({ decision }: { decision: ProofDecision }) {
  if (decision === "approved") {
    return (
      <div className="flex flex-col items-center gap-2 rounded-card border border-sage/30 bg-sage/10 p-6 text-center">
        <span className="flex size-11 items-center justify-center rounded-full bg-sage text-surface">
          <CheckIcon />
        </span>
        <h2 className="text-lg font-semibold text-ink">Portrait approved</h2>
        <p className="text-sm text-slate">
          Thank you! We&rsquo;ve received your approval and will take it from
          here.
        </p>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center gap-2 rounded-card border border-pigment/30 bg-pigment-soft p-6 text-center">
      <span className="flex size-11 items-center justify-center rounded-full bg-pigment text-surface">
        <CheckIcon />
      </span>
      <h2 className="text-lg font-semibold text-ink">Changes requested</h2>
      <p className="text-sm text-slate">
        Thanks — your notes are with our design team. We&rsquo;ll send an updated
        proof soon.
      </p>
    </div>
  );
}

function CheckIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M20 6 9 17l-5-5"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
