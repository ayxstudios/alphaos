"use client";

import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";
import { focusRing } from "./styles";
import { Check, Copy } from "./icons";
import { useToast } from "./toast";

/** How long the button says "Copied" (and a CopyField stays lit). */
const COPIED_MS = 1800;

/**
 * Put exactly `text` on the clipboard. The async Clipboard API first; the old
 * hidden-textarea copy when it is missing or refused (an http page, an older
 * in-app browser). True when the text was copied.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the old way */
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.inset = "0";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    area.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

/**
 * Copies one exact piece of text (an order number, a name, a note), never the
 * page around it, and says so on the button itself: "Copy" turns into a green
 * "Copied" for a moment.
 */
export function CopyButton({
  text,
  what,
  className,
  onCopied,
}: {
  text: string;
  /** What is copied, in words: "order number". Read out with the button and shown on hover. */
  what: string;
  className?: string;
  onCopied?: () => void;
}) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  async function copy(event: React.MouseEvent) {
    // Inside a card or a <summary>, a copy must not also open or toggle it.
    event.stopPropagation();
    if (!(await copyText(text))) {
      toast({ variant: "danger", title: "Could not copy", description: "Select the text and copy it by hand." });
      return;
    }
    setCopied(true);
    onCopied?.();
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_MS);
  }

  return (
    <button
      type="button"
      onClick={copy}
      title={`Copy ${what}`}
      className={cn(
        // Phone: a 44px tap target; laptop keeps it compact. Wide enough for
        // "Copied" so the swap never shifts the line.
        "inline-flex h-8 min-h-11 min-w-[5.25rem] shrink-0 items-center justify-center gap-1.5 rounded-input border px-2.5 text-xs font-medium select-none sm:min-h-0",
        "transition-colors motion-hover",
        focusRing,
        copied
          ? "border-sage/30 bg-sage/10 text-sage"
          : "border-line bg-surface text-ink hover:border-slate/40 hover:bg-canvas",
        className,
      )}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
      <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
      <span className="sr-only"> {what}</span>
    </button>
  );
}

/**
 * A value with its own Copy button. The value lights up while the button says
 * "Copied", so it is plain exactly which text went to the clipboard.
 */
export function CopyField({
  text,
  what,
  inline = false,
  className,
  children,
}: {
  text: string;
  what: string;
  /** A one-line value with the button right after it, instead of at the far end of the row. */
  inline?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const [lit, setLit] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const value = (
    <div
      className={cn(
        "-mx-1.5 -my-1 min-w-0 rounded-input px-1.5 py-1 transition-colors motion-layout",
        lit && "bg-pigment-soft",
      )}
    >
      {children}
    </div>
  );
  const button = text.trim() ? (
    <CopyButton
      text={text}
      what={what}
      // A longer value wraps around the button and then takes the full
      // width, so a note on a phone is not squeezed into a narrow column.
      className={inline ? undefined : "float-right mb-1 ml-2"}
      onCopied={() => {
        setLit(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setLit(false), COPIED_MS);
      }}
    />
  ) : null;

  if (inline) {
    return (
      <div className={cn("flex items-center gap-2", className)}>
        {value}
        {button}
      </div>
    );
  }
  return (
    <div className={cn("flow-root", className)}>
      {button}
      {value}
    </div>
  );
}
