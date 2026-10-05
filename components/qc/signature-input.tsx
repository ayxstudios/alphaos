"use client";

import { useId } from "react";

import { cn } from "@/lib/utils";
import { focusRing } from "@/components/ui/styles";

/**
 * The QC signature. The reviewer types their own name, by hand, every time:
 * nothing is prefilled from the account, paste and drop are refused, and
 * browser autofill is turned off. Keystroke-counting is deliberately NOT used
 * to spot paste: predictive/swipe keyboards and IMEs commit whole words as one
 * change event, and the old "one character at a time" guard silently threw the
 * VAs' typing away, leaving Pass/Fail locked forever on their tablets.
 * ANY typed name signs (owner 2026-10-06: "anyone's name can work, it's only
 * for us to backlog really") — the name is a backlog trail, not a gate, so
 * there is no team-list check; the typed name is recorded as the signer.
 * Owner 2026-09-09: "a kind of signature where it adds a level of
 * psychological accountability".
 */
export function signatureName(s: string): string {
  return s.trim().replace(/\s+/g, " ");
}

export function SignatureInput({
  value,
  onChange,
  disabled = false,
  idleHint = "Type your name to unlock Pass and Fail.",
}: {
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  idleHint?: string;
}) {
  // A per-mount name keeps password managers from offering a saved value; useId
  // is the same on the server and in the browser (Math.random here was a
  // hydration mismatch on every QC page).
  const autofillGuard = useId().replace(/[^a-z0-9]/gi, "");
  const matchedName = signatureName(value);
  // Two characters is the floor so a stray tap can't sign; beyond that any
  // name unlocks (the signature is for the backlog, not a gate).
  const matches = matchedName.length >= 2;

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor="qc-signature" className="text-xs font-medium text-ink">
        Sign your name:
      </label>
      <input
        id="qc-signature"
        type="text"
        value={value}
        disabled={disabled}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="words"
        spellCheck={false}
        data-lpignore="true"
        data-1p-ignore="true"
        data-form-type="other"
        name={`qc-signature-${autofillGuard}`}
        placeholder="Your name"
        aria-describedby="qc-signature-hint"
        onPaste={(e) => e.preventDefault()}
        onDrop={(e) => e.preventDefault()}
        onDragOver={(e) => e.preventDefault()}
        onContextMenu={(e) => e.preventDefault()}
        onChange={(e) => onChange(e.currentTarget.value)}
        className={cn(
          "h-10 w-full rounded-input border bg-surface px-3 font-display text-base italic text-ink placeholder:not-italic placeholder:text-slate/70",
          matches ? "border-sage/40" : "border-line",
          focusRing,
        )}
      />
      {matches ? (
        <p id="qc-signature-hint" className="text-xs text-sage">
          Signed as {matchedName}.
        </p>
      ) : (
        <p id="qc-signature-hint" className="text-xs text-slate">
          {idleHint}
        </p>
      )}
    </div>
  );
}
