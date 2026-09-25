"use client";

import { useId, useRef } from "react";

import { cn } from "@/lib/utils";
import { focusRing } from "@/components/ui/styles";

/**
 * The QC signature. The reviewer types their own name, by hand, every time:
 * nothing is prefilled from the account, paste and drop are refused, browser
 * autofill is turned off, and any change that is not a single keystroke
 * (autocomplete, a paste that slipped past the event, a drag) is thrown away.
 * Pass and Fail stay locked until what was typed matches the signed-in name.
 * Owner 2026-09-09: "a kind of signature where it adds a level of
 * psychological accountability".
 */
export function normalizeSignature(s: string): string {
  return s.trim().replace(/\s+/g, " ").toLowerCase();
}

export function SignatureInput({
  value,
  onChange,
  expectedName,
  disabled = false,
}: {
  value: string;
  onChange: (next: string) => void;
  expectedName: string;
  disabled?: boolean;
}) {
  const last = useRef(value);
  // A per-mount name keeps password managers from offering a saved value; useId
  // is the same on the server and in the browser (Math.random here was a
  // hydration mismatch on every QC page).
  const autofillGuard = useId().replace(/[^a-z0-9]/gi, "");
  const matches = value.length > 0 && normalizeSignature(value) === normalizeSignature(expectedName);

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
        onChange={(e) => {
          const next = e.currentTarget.value;
          const prev = last.current;
          // Accept one typed character, a deletion, or a clear. Anything that
          // adds more than one character at once did not come from the keys.
          const grew = next.length - prev.length;
          if (grew > 1) {
            e.currentTarget.value = prev;
            return;
          }
          last.current = next;
          onChange(next);
        }}
        className={cn(
          "h-10 w-full rounded-input border bg-surface px-3 font-display text-base italic text-ink placeholder:not-italic placeholder:text-slate/70",
          matches ? "border-sage/40" : "border-line",
          focusRing,
        )}
      />
      {matches ? (
        <p id="qc-signature-hint" className="text-xs text-sage">
          Signed as {expectedName.trim()}.
        </p>
      ) : (
        <span id="qc-signature-hint" className="sr-only">
          Type your name, {expectedName.trim()}, to unlock Pass and Fail.
        </span>
      )}
    </div>
  );
}
