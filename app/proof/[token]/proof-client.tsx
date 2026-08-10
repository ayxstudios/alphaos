"use client";

import { useEffect, useRef, useState } from "react";

import { Button, Skeleton, Textarea } from "@/components/ui";
import {
  CheckCircle,
  Eye,
  Pause,
  Pencil,
  X,
  ZoomIn,
} from "@/components/ui/icons";
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
  /** ISO timestamp, only present once a decision has been recorded. */
  decidedAt: string | null;
};

type Mode = "idle" | "confirmApprove" | "revise";

export function ProofClient({
  token,
  orderNumber,
  hasPreview,
  actionable,
  initialDecision,
  decidedAt,
}: Props) {
  const [outcome, setOutcome] = useState<ProofDecision | null>(initialDecision);
  const [mode, setMode] = useState<Mode>("idle");
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [note, setNote] = useState("");
  const [pins, setPins] = useState<ProofAnnotation[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [imageLoaded, setImageLoaded] = useState(false);
  const [zoomOpen, setZoomOpen] = useState(false);
  const [decidedOn, setDecidedOn] = useState<string | null>(decidedAt);
  const imgRef = useRef<HTMLImageElement>(null);

  // Log the view once, on mount. Fire-and-forget; failures are non-fatal.
  useEffect(() => {
    void trackView(token);
  }, [token]);

  // Let Escape close the full-size view.
  useEffect(() => {
    if (!zoomOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setZoomOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoomOpen]);

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
    if (res.ok) {
      setOutcome("approved");
      setDecidedOn(new Date().toISOString());
    } else {
      setError(res.message);
    }
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
    if (res.ok) {
      setOutcome("revision");
      setDecidedOn(new Date().toISOString());
    } else {
      setError(res.message);
    }
  }

  const previewSrc = `/api/proof/${token}/preview`;

  return (
    <div className="flex flex-col gap-6">
      <div aria-live="polite" className="flex justify-center">
        <StatusLine outcome={outcome} actionable={actionable} decidedAt={decidedOn} />
      </div>

      {/* Preview -------------------------------------------------------- */}
      {hasPreview ? (
        <figure className="relative rounded-card border border-line bg-canvas p-2.5 shadow-md sm:p-4">
          <div className="relative overflow-hidden rounded-input bg-line/40">
            {!imageLoaded && (
              <Skeleton className="absolute inset-0 aspect-square w-full" />
            )}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              ref={imgRef}
              src={previewSrc}
              alt={`Portrait proof for order ${orderNumber}`}
              onClick={addPin}
              onLoad={() => setImageLoaded(true)}
              className={
                "block w-full select-none transition-opacity duration-300 " +
                (imageLoaded ? "opacity-100" : "opacity-0") +
                " " +
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

            {mode !== "revise" && imageLoaded && (
              <button
                type="button"
                onClick={() => setZoomOpen(true)}
                aria-label="View full size"
                className="motion-hover absolute bottom-2.5 right-2.5 inline-flex items-center gap-1.5 rounded-chip bg-ink/70 px-2.5 py-1.5 text-xs font-medium text-surface backdrop-blur-sm hover:bg-ink/85"
              >
                <ZoomIn size={14} />
                View full size
              </button>
            )}
          </div>

          {mode === "revise" && (
            <p className="px-1 pt-2.5 text-center text-xs text-slate">
              Tap anywhere on the portrait to point at a spot.
            </p>
          )}
        </figure>
      ) : (
        <div className="rounded-card border border-dashed border-line bg-surface p-10 text-center text-sm text-slate">
          Your proof is being prepared. Please check back shortly.
        </div>
      )}

      {/* Outcome (read-only once decided) ------------------------------ */}
      {outcome ? (
        <Confirmation decision={outcome} decidedAt={decidedOn} />
      ) : !actionable ? (
        <p className="rounded-card border border-line bg-surface p-4 text-center text-sm text-slate">
          This proof isn&rsquo;t awaiting your review right now.
        </p>
      ) : (
        <>
          {error && (
            <p className="rounded-input border border-rose/30 bg-rose/10 p-3 text-sm text-rose" role="alert">
              {error}
            </p>
          )}

          {mode === "idle" && (
            <div className="flex flex-col gap-3">
              <Button
                size="lg"
                onClick={() => setMode("confirmApprove")}
                className="gap-2.5"
              >
                <CheckCircle size={18} />
                Approve this portrait
              </Button>
              <Button
                size="lg"
                variant="secondary"
                onClick={() => setMode("revise")}
                className="gap-2.5"
              >
                <Pencil size={18} />
                Request a change
              </Button>
            </div>
          )}

          {mode === "confirmApprove" && (
            <div className="flex flex-col gap-4 rounded-card border border-line bg-surface p-5">
              <div className="flex flex-col gap-1">
                <h2 className="font-display text-xl text-ink">
                  Happy with your portrait?
                </h2>
                <p className="text-sm text-slate">
                  Once you approve, we&rsquo;ll get it ready for you — there are
                  no further changes after this.
                </p>
              </div>
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
            <div className="flex flex-col gap-4 rounded-card border border-line bg-surface p-5">
              <div>
                <h2 className="font-display text-xl text-ink">
                  What would you like changed?
                </h2>
                <p className="mt-1 text-sm text-slate">
                  Pick anything that applies, add a note, and tap the portrait
                  to point at a spot.
                </p>
              </div>

              <fieldset className="flex flex-col gap-2">
                <legend className="sr-only">Issues with this proof</legend>
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

              <Textarea
                label="Anything else? (optional)"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={4}
                maxLength={2000}
                placeholder="Add any details that will help us get it just right…"
              />

              {pins.length > 0 && (
                <div className="flex items-center justify-between text-sm text-slate">
                  <span>
                    {pins.length} spot{pins.length === 1 ? "" : "s"} marked on
                    the portrait
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

      {/* Full-size view --------------------------------------------------- */}
      {zoomOpen && hasPreview && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/90 p-4 sm:p-8"
          onClick={() => setZoomOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-label="Full size portrait proof"
        >
          <button
            type="button"
            onClick={() => setZoomOpen(false)}
            aria-label="Close full size view"
            className="motion-hover absolute right-4 top-4 flex size-10 items-center justify-center rounded-full bg-surface/15 text-surface hover:bg-surface/25"
          >
            <X size={20} />
          </button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={previewSrc}
            alt={`Full size portrait proof for order ${orderNumber}`}
            className="max-h-full max-w-full rounded-input object-contain"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </div>
  );
}

function StatusLine({
  outcome,
  actionable,
  decidedAt,
}: {
  outcome: ProofDecision | null;
  actionable: boolean;
  decidedAt: string | null;
}) {
  const date = formatDate(decidedAt);

  if (outcome === "approved") {
    return (
      <StatusPill tone="sage" icon={CheckCircle}>
        Approved{date ? ` on ${date}` : ""}
      </StatusPill>
    );
  }
  if (outcome === "revision") {
    return (
      <StatusPill tone="pigment" icon={Pencil}>
        Revision requested{date ? ` on ${date}` : ""}
      </StatusPill>
    );
  }
  if (actionable) {
    return (
      <StatusPill tone="amber" icon={Eye}>
        Awaiting your review
      </StatusPill>
    );
  }
  return (
    <StatusPill tone="slate" icon={Pause}>
      Not awaiting review right now
    </StatusPill>
  );
}

type PillTone = "sage" | "pigment" | "amber" | "slate";

const pillToneClasses: Record<PillTone, string> = {
  sage: "text-sage bg-sage/[0.1] ring-sage/20",
  pigment: "text-pigment bg-pigment-soft ring-pigment/15",
  amber: "text-amber bg-amber/[0.1] ring-amber/20",
  slate: "text-slate bg-slate/[0.08] ring-slate/15",
};

function StatusPill({
  tone,
  icon: Glyph,
  children,
}: {
  tone: PillTone;
  icon: (p: { size?: number; className?: string }) => React.ReactElement;
  children: React.ReactNode;
}) {
  return (
    <span
      className={
        "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium ring-1 ring-inset " +
        pillToneClasses[tone]
      }
    >
      <Glyph size={15} className="shrink-0" />
      {children}
    </span>
  );
}

function Confirmation({
  decision,
  decidedAt,
}: {
  decision: ProofDecision;
  decidedAt: string | null;
}) {
  const date = formatDate(decidedAt);

  if (decision === "approved") {
    return (
      <div className="flex flex-col items-center gap-3 rounded-card border border-sage/30 bg-sage/10 p-8 text-center">
        <span className="flex size-14 items-center justify-center rounded-full bg-sage text-surface">
          <CheckIcon />
        </span>
        <div className="flex flex-col gap-1">
          <h2 className="font-display text-2xl text-ink">Portrait approved</h2>
          <p className="max-w-sm text-sm text-slate">
            Thank you! We&rsquo;ve received your approval{date ? ` (${date})` : ""}{" "}
            and will take it from here.
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center gap-3 rounded-card border border-pigment/30 bg-pigment-soft p-8 text-center">
      <span className="flex size-14 items-center justify-center rounded-full bg-pigment text-surface">
        <CheckIcon />
      </span>
      <div className="flex flex-col gap-1">
        <h2 className="font-display text-2xl text-ink">Changes requested</h2>
        <p className="max-w-sm text-sm text-slate">
          Thanks — your notes are with our design team{date ? ` (${date})` : ""}.
          We&rsquo;ll send an updated proof soon.
        </p>
      </div>
    </div>
  );
}

function CheckIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
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

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return null;
  }
}
