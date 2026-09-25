"use client";

import { useEffect } from "react";

/**
 * The app-wide error boundary (customer + security QA 2026-09-25). A thrown
 * server error used to show Next's default "Application error" text. This
 * page is plain and branded, shows no message, digest, stack or path (the
 * error is logged on the server; only the digest reaches the browser), and
 * offers a retry. Client component by Next's contract for error.tsx.
 */
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // The digest links this view to the server log line; nothing else is logged here.
    console.error("[app] page error", error.digest ?? "no digest");
  }, [error]);

  return (
    <main className="mx-auto flex min-h-[70vh] w-full max-w-md flex-col items-center justify-center gap-4 px-4 text-center">
      <div className="flex size-10 items-center justify-center rounded-card bg-pigment font-display text-lg font-bold text-surface">
        A
      </div>
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold text-ink">Something went wrong</h1>
        <p className="text-sm text-slate">
          That page did not load. Please try again. If it keeps happening, wait a few minutes and
          open the link again.
        </p>
      </div>
      <button
        type="button"
        onClick={reset}
        className="inline-flex h-11 items-center justify-center rounded-input bg-pigment px-5 text-sm font-medium text-surface transition-opacity duration-[120ms] hover:opacity-90"
      >
        Try again
      </button>
    </main>
  );
}
