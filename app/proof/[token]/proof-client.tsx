"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui";
import { focusRing } from "@/components/ui/styles";
import { PROOF_ISSUES } from "@/lib/proofs/issues";
import type { ProofAnnotation } from "@/lib/db/schema";
import type { ProofDecision } from "@/lib/proofs/decide";
import type { ProofPortrait } from "@/lib/proofs/data";
import { approveAction, revisionAction, trackView } from "./actions";

type Props = {
  token: string;
  orderNumber: string;
  hasPreview: boolean;
  /** 2+ entries = one preview per portrait, each under its own heading. */
  portraits?: ProofPortrait[];
  actionable: boolean;
  initialDecision: ProofDecision | null;
  /** A newer proof went out after this one (this link is an older email's). */
  superseded?: boolean;
};

type Mode = "idle" | "confirmApprove" | "revise";

export function ProofClient({
  token,
  orderNumber,
  hasPreview,
  portraits = [],
  actionable,
  initialDecision,
  superseded = false,
}: Props) {
  const multi = portraits.length > 1;
  const [outcome, setOutcome] = useState<ProofDecision | null>(initialDecision);
  const [mode, setMode] = useState<Mode>("idle");
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [note, setNote] = useState("");
  const [pins, setPins] = useState<ProofAnnotation[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Log the view once, on mount. Fire-and-forget; failures are non-fatal.
  useEffect(() => {
    void trackView(token);
  }, [token]);

  function cancelRevision() {
    setPins([]);
    setChecked(new Set());
    setNote("");
    setError(null);
    setMode("idle");
  }

  function toggleIssue(key: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function addPin(e: React.MouseEvent<HTMLImageElement>, portrait?: number) {
    if (mode !== "revise") return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    // On a 2+ portrait order the pin remembers which portrait it was dropped
    // on, so the designer sees it over the right image.
    setPins((prev) => [...prev, portrait ? { x, y, p: portrait } : { x, y }]);
  }

  /** One preview image with its pins; the whole proof, or one portrait of it. */
  function preview(portrait?: ProofPortrait) {
    const src = portrait ? `/api/proof/${token}/preview?p=${portrait.n}` : `/api/proof/${token}/preview`;
    const mine = pins
      .map((pin, i) => ({ ...pin, n: i + 1 }))
      .filter((pin) => (portrait ? pin.p === portrait.n : true));
    return (
      <div className="flex flex-col gap-2">
        <figure className="relative bg-canvas">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt={portrait ? `Portrait ${portrait.n} proof for order ${orderNumber}` : `Portrait proof for order ${orderNumber}`}
            onClick={(e) => addPin(e, portrait?.n)}
            className={"block h-auto w-full select-none " + (mode === "revise" ? "cursor-crosshair" : "")}
            draggable={false}
          />
          {mine.map((pin) => (
            <span
              key={pin.n}
              className="pointer-events-none absolute flex size-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-pigment text-xs font-semibold text-surface shadow-md ring-2 ring-surface"
              style={{ left: `${pin.x * 100}%`, top: `${pin.y * 100}%` }}
            >
              {pin.n}
            </span>
          ))}
        </figure>
        <a
          href={`${src}${portrait ? "&" : "?"}download=1`}
          className={
            "inline-flex h-11 items-center justify-center rounded-input border border-line bg-surface px-4 text-base font-semibold text-ink " +
            "transition-[background-color,border-color] duration-[120ms] hover:border-slate/40 hover:bg-canvas active:bg-pigment-soft " +
            focusRing
          }
        >
          {portrait ? `Download portrait ${portrait.n}` : "Download your portrait"}
        </a>
      </div>
    );
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
      {multi ? (
        // 2+ portraits: each under its own heading so the customer always
        // knows which one they are looking at and marking.
        <div className="flex flex-col gap-5">
          {portraits.map((portrait) => (
            <section key={portrait.n} className="flex flex-col gap-2" aria-label={`Portrait ${portrait.n}`}>
              <h2 className="text-base font-semibold text-ink">
                Portrait {portrait.n}
                {portrait.label && (
                  <span className="ml-2 font-normal text-slate">{portrait.label}</span>
                )}
              </h2>
              {portrait.hasPreview ? (
                preview(portrait)
              ) : (
                <div className="rounded-card border border-dashed border-line bg-surface p-6 text-center text-base text-slate">
                  This one is still being prepared.
                </div>
              )}
            </section>
          ))}
        </div>
      ) : hasPreview ? (
        preview()
      ) : actionable && !outcome ? (
        // "Being prepared" only while a decision is still to come; a decided
        // proof with no image left says nothing here (its outcome card does).
        <div className="rounded-card border border-dashed border-line bg-surface p-8 text-center text-base text-slate">
          Your proof is being prepared. Please check back shortly.
        </div>
      ) : null}

      {superseded && outcome !== "revision" && (
        <p className="rounded-card border border-line bg-surface p-4 text-center text-base text-slate">
          We have sent you an updated proof. Please open the link in our most recent email.
        </p>
      )}

      {/* Outcome (read-only once decided) ------------------------------ */}
      {outcome ? (
        <Confirmation decision={outcome} superseded={superseded} multi={multi} />
      ) : !actionable ? (superseded ? null : (
        <p className="rounded-card border border-line bg-surface p-4 text-center text-base text-slate">
          This proof isn&rsquo;t awaiting your review right now.
        </p>
      )) : (
        <>
          {error && (
            <p className="rounded-input border border-rose/30 bg-rose/10 p-3 text-base text-rose">
              {error}
            </p>
          )}

          {mode === "idle" && (
            <div className="flex flex-col gap-3">
              <Button size="lg" onClick={() => setMode("confirmApprove")}>
                {multi ? "Approve these portraits" : "Approve this portrait"}
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
                {multi
                  ? "Happy with all of your portraits? Once you approve, we\u2019ll get them ready for you. No further changes after this."
                  : "Happy with your portrait? Once you approve, we\u2019ll get it ready for you. No further changes after this."}
              </p>
              <div className="flex flex-col gap-2 sm:flex-row-reverse">
                <Button
                  size="lg"
                  onClick={onApprove}
                  loading={submitting}
                  className="sm:flex-1"
                >
                  {multi ? "Yes, approve them" : "Yes, approve it"}
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
                <p className="mt-1 text-base text-slate">
                  Pick anything that applies, add a note, and tap {multi ? "a portrait" : "the image"} to
                  point at a spot.
                </p>
              </div>

              <fieldset className="flex flex-col gap-2">
                {PROOF_ISSUES.map((issue) => (
                  <label
                    key={issue.key}
                    className="relative flex min-h-14 cursor-pointer items-center rounded-input border border-line py-3 pl-14 pr-3 text-base text-ink has-[:checked]:border-pigment has-[:checked]:bg-pigment-soft has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-pigment has-[:focus-visible]:ring-offset-2 motion-hover"
                  >
                    <input
                      type="checkbox"
                      checked={checked.has(issue.key)}
                      onChange={() => toggleIssue(issue.key)}
                      className="peer absolute left-1 top-1/2 size-11 -translate-y-1/2 cursor-pointer opacity-0"
                    />
                    <span aria-hidden="true" className="pointer-events-none absolute left-4 flex size-5 items-center justify-center rounded-input border border-slate bg-surface text-transparent peer-checked:border-pigment peer-checked:bg-pigment peer-checked:text-surface">
                      <CheckIcon />
                    </span>
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
                className="w-full rounded-input border border-line bg-canvas p-3 text-base text-ink placeholder:text-slate focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pigment"
              />

              {pins.length > 0 && (
                <div className="flex items-center justify-between text-base text-slate">
                  <span>
                    {pins.length} spot{pins.length === 1 ? "" : "s"} marked on the{" "}
                    {multi ? "portraits" : "image"}
                  </span>
                  <button
                    type="button"
                    onClick={() => setPins([])}
                    className={"-my-2 inline-flex min-h-11 shrink-0 items-center rounded-input px-2 font-medium text-pigment underline-offset-2 hover:underline active:bg-pigment-soft " + focusRing}
                  >
                    Clear spots
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
                  onClick={cancelRevision}
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

function Confirmation({ decision, superseded, multi }: { decision: ProofDecision; superseded: boolean; multi: boolean }) {
  if (decision === "approved") {
    return (
      <div className="flex flex-col items-center gap-2 rounded-card border border-sage/30 bg-sage/10 p-6 text-center">
        <span className="flex size-11 items-center justify-center rounded-full bg-sage text-surface">
          <CheckIcon />
        </span>
        <h2 className="text-lg font-semibold text-ink">{multi ? "Portraits approved" : "Portrait approved"}</h2>
        <p className="text-base text-ink">
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
      {superseded ? (
        <p className="text-base text-slate">
          We&rsquo;ve since sent you an updated proof. Please open the link in
          our most recent email.
        </p>
      ) : (
        <p className="text-base text-slate">
          Thanks. Your notes are with our design team. We&rsquo;ll send an updated
          proof soon.
        </p>
      )}
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
