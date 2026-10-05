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
 * Pass and Fail stay locked until what was typed matches a QC teammate's name
 * (the VAs share logins, owner 2026-10-05, so any team member's name signs).
 * Owner 2026-09-09: "a kind of signature where it adds a level of
 * psychological accountability".
 */
export function normalizeSignature(s: string): string {
  return s.trim().replace(/\s+/g, " ").toLowerCase();
}

export function SignatureInput({
  value,
  onChange,
  teamNames,
  disabled = false,
  idleHint = "Type your name to unlock Pass and Fail.",
}: {
  value: string;
  onChange: (next: string) => void;
  teamNames: string[];
  disabled?: boolean;
  idleHint?: string;
}) {
  // A per-mount name keeps password managers from offering a saved value; useId
  // is the same on the server and in the browser (Math.random here was a
  // hydration mismatch on every QC page).
  const autofillGuard = useId().replace(/[^a-z0-9]/gi, "");
  const matchedName =
    value.length > 0
      ? teamNames.find((n) => normalizeSignature(value) === normalizeSignature(n))
      : undefined;
  const matches = Boolean(matchedName);
  // Mid-typing is not a mistake: only warn once what's typed can no longer
  // become a team member's name (not a prefix of any of them).
  const offTrack =
    !matches &&
    value.trim().length > 0 &&
    !teamNames.some((n) => normalizeSignature(n).startsWith(normalizeSignature(value)));

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
          Signed as {matchedName?.trim()}.
        </p>
      ) : offTrack ? (
        <p id="qc-signature-hint" className="text-xs text-rose" role="alert">
          That name isn&apos;t on the QC team list. Type a team member&apos;s name as it appears on their account.
        </p>
      ) : (
        <p id="qc-signature-hint" className="text-xs text-slate">
          {idleHint}
        </p>
      )}
    </div>
  );
}
