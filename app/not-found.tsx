import type { Metadata } from "next";
import Link from "next/link";

// A buyer's tab reads what happened, never the internal app name (the root
// layout's title); no indexing for a dead link.
export const metadata: Metadata = { title: "Page not found", robots: { index: false, follow: false } };

/**
 * The app-wide 404 (customer + security QA 2026-09-25). Before this a mistyped
 * link answered with Next's default "404 | This page could not be found", an
 * unbranded page a buyer could land on from a broken email link. Same calm
 * shape as the proof and upload "Link not found" pages, plus the way to sign in
 * for staff who typed a path wrong. Server component, no data, no session.
 */
export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-[70vh] w-full max-w-md flex-col items-center justify-center gap-4 px-4 text-center">
      <div className="flex size-10 items-center justify-center rounded-card bg-pigment font-display text-lg font-bold text-surface">
        A
      </div>
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold text-ink">Page not found</h1>
        <p className="text-sm text-slate">
          That link does not go anywhere. If it came from an email we sent you, please reply to that
          email and we will send a fresh one.
        </p>
      </div>
      <Link
        href="/login"
        className="inline-flex h-11 items-center justify-center rounded-input border border-line bg-surface px-5 text-sm font-medium text-ink transition-opacity duration-[120ms] hover:opacity-90"
      >
        Go to sign in
      </Link>
    </main>
  );
}
