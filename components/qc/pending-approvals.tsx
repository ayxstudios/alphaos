"use client";

import { useRouter } from "next/navigation";
import { PrefetchKind } from "next/dist/client/components/router-reducer/router-reducer-types";
import { useEffect, useState, useSyncExternalStore } from "react";

import { useToast } from "@/components/ui";
import { focusRing } from "@/components/ui/styles";
import { cn } from "@/lib/utils";
import {
  APPROVE_GRACE_MS,
  OVERRIDABLE_CODES,
  createApprovalStore,
  type CommitResult,
  type PendingRow,
} from "./pending-approvals-store";

export { APPROVE_GRACE_MS };

// Sending runs in the background (it can take ~20 s server side), so the
// wait sits just under the commit route's 60 s maxDuration.
const COMMIT_TIMEOUT_MS = 55_000;
/** Full RSC prefetch: the server render of /approve takes seconds, so Approve and Stop swap from the cache instead. */
export const FULL_PREFETCH = { kind: PrefetchKind.FULL };

async function viaRoute(orderId: string, keepalive: boolean, fixIds?: string[], overrideReason?: string, signal?: AbortSignal): Promise<CommitResult> {
  const res = await fetch("/api/approve/commit", {
    method: "POST",
    keepalive,
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orderId, ...(fixIds?.length ? { fixIds } : {}), ...(overrideReason ? { overrideReason } : {}) }),
  });
  return (await res.json()) as CommitResult;
}

// The send goes through the plain route, not the ownerApprove server action
// (2026-10-22): an action that revalidates answers with a fresh render of
// /approve and empties the browser's preloaded pages, so the order the owner
// moved on to lost its preloaded next one and that Approve waited seconds.
// No browser prompt any more (it popped up 8 s later over the next order and
// refused "OK"; Ayser 2026-10-22: "Do not do the popup thing"): what can stop
// a send is shown on the screen and the Approve carries the owner's say. Only
// something the screen did not show can still stop it, and that row has a
// one-tap Send anyway.
// Same protections as before: a dropped connection or a 55 s stall ends with
// a reason, and a retry is safe because the server answers "Already checked".
async function commit(orderId: string, fixIds?: string[], overrideReason?: string): Promise<CommitResult> {
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), COMMIT_TIMEOUT_MS);
  try {
    return await viaRoute(orderId, false, fixIds, overrideReason, stop.signal);
  } catch (err) {
    const timedOut = stop.signal.aborted || (err instanceof Error && err.name === "AbortError");
    return {
      ok: false,
      code: timedOut ? "timeout" : "network",
      message: timedOut ? "No answer after a minute, it may not have gone through." : "That didn't go through (connection dropped).",
    };
  } finally {
    clearTimeout(timer);
  }
}

// The store lives at module level so rows (and their timers) survive the
// router.replace + refresh that remounts the screen after every Approve.
export const approvalStore = createApprovalStore({
  commit,
  beacon: (orderId, fixIds, overrideReason) => viaRoute(orderId, true, fixIds, overrideReason),
  schedule: (fn, ms) => setTimeout(fn, ms),
  cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
});

if (typeof window !== "undefined") {
  // Leaving the page inside the Stop window: send everything at once.
  window.addEventListener("pagehide", () => approvalStore.flush());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") approvalStore.flush();
  });
}

const NONE: PendingRow[] = [];
export function usePendingApprovals(): PendingRow[] {
  return useSyncExternalStore(approvalStore.subscribe, approvalStore.getRows, () => NONE);
}

/**
 * `/approve?...` with the pending ids kept out of the queue. `also` adds one
 * more id to skip: the order about to be approved, so the page the screen will
 * move to can be preloaded before the tap (the URL must match exactly).
 */
let streamHint: "new" | "revision" | null = null;
/** The stream on screen: where "/approve" lands when an order was the last one in it. */
export function setApproveStream(stream: "new" | "revision" | null) {
  streamHint = stream;
}

export function approveHref(orderId: string | null, exclude?: string, also?: string): string {
  const skip = approvalStore.skipIds().filter((id) => id !== exclude);
  if (also && also !== exclude && !skip.includes(also)) skip.push(also);
  const q = new URLSearchParams();
  if (orderId) q.set("o", orderId);
  // With no order to open (the stream is finished) stay in the stream the owner is working (2026-10-21).
  else if (streamHint) q.set("s", streamHint);
  if (skip.length) q.set("skip", skip.join(","));
  const s = q.toString();
  return s ? `/approve?${s.replace(/%2C/g, ",")}` : "/approve";
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

function firstName(full: string): string {
  const f = full.trim().split(/\s+/)[0];
  return !f || f === "-" ? "the customer" : f;
}

/** The done line: only an emailed proof is "Sent". */
function doneLine(r: PendingRow): string {
  if (r.delivery === "etsy") return `Etsy message queued for ${firstName(r.customerName)}`;
  if (r.delivery === "held") return "Approved, waits for an owner";
  return `Sent to ${firstName(r.customerName)}`;
}

/**
 * A send stopped by something the screen did not show (a picture match found
 * only at send time, an Auto QC check that landed after the page opened, or a
 * VA's send; 2026-10-22). One tap sends it, no prompt and no typing; the line
 * is logged on the order with what stopped it.
 */
function SendAnyway({ row }: { row: PendingRow }) {
  return (
    <div className="flex gap-2 px-3 pb-3">
      <button
        type="button"
        data-testid="send-anyway"
        onClick={() => approvalStore.retry(row.orderId, `Sent anyway from the Approve screen after: ${row.message ?? "a stop"}`)}
        className={cn("h-11 flex-1 rounded-input bg-sage px-3 text-sm font-semibold text-surface", focusRing)}
      >
        Send anyway
      </button>
    </div>
  );
}

function Rows({ rows }: { rows: PendingRow[] }) {
  const router = useRouter();
  const toast = useToast();
  const now = useNow(rows.some((r) => r.status === "pending"));
  // Stop brings the order straight back: preload that page while it is pending.
  const stopHrefs = rows.filter((r) => r.status === "pending").map((r) => approveHref(r.orderId, r.orderId)).join(" ");
  useEffect(() => {
    if (stopHrefs) stopHrefs.split(" ").forEach((h) => router.prefetch(h, FULL_PREFETCH));
  }, [stopHrefs, router]);

  return (
    <>
      {rows.map((r) => {
        const left = Math.max(0, r.endsAt - now);
        const pct = Math.min(100, (left / (r.endsAt - r.startedAt)) * 100);
        return (
          <div
            key={r.orderId}
            data-testid="pending-approval"
            data-status={r.status}
            className="overflow-hidden rounded-card border border-line bg-surface shadow-lg"
          >
            <div className="flex items-center gap-3 px-3 py-2">
              <p className="min-w-0 flex-1 text-sm text-ink" aria-live="polite">
                {r.status === "pending" ? (
                  <>
                    <span className="font-semibold">
                      Approving {r.orderNumber}
                      {r.fixIds?.length ? " with the AI fix" : ""}
                    </span>
                    <span className="text-slate"> · sends in {Math.ceil(left / 1000)} s</span>
                  </>
                ) : r.status === "sending" ? (
                  <span className="font-semibold">Sending {r.orderNumber}...</span>
                ) : r.status === "sent" ? (
                  <span className="font-semibold text-sage">{doneLine(r)}</span>
                ) : (
                  <>
                    <span className="font-semibold">{r.orderNumber} not sent.</span>
                    <span className="text-slate"> {r.message}</span>
                    {r.code && OVERRIDABLE_CODES.has(r.code) ? <span className="text-ink"> Open it to look, or send it anyway.</span> : null}
                  </>
                )}
              </p>
              {r.status === "pending" ? (
                <button
                  type="button"
                  data-testid="stop-approval"
                  onClick={() => {
                    if (!approvalStore.stop(r.orderId)) return;
                    toast({ variant: "info", title: "Stopped, nothing sent" });
                    // Prefetched in full above; no refresh, it would discard that.
                    router.replace(approveHref(r.orderId));
                  }}
                  className={cn("min-h-11 min-w-11 shrink-0 rounded-input border-2 border-rose px-4 text-sm font-semibold text-rose", focusRing)}
                >
                  Stop
                </button>
              ) : null}
              {r.status === "failed" ? (
                <div className="flex shrink-0 gap-2">
                  {r.code && OVERRIDABLE_CODES.has(r.code) ? null : (
                    <button
                      type="button"
                      data-testid="retry-approval"
                      onClick={() => approvalStore.retry(r.orderId)}
                      className={cn("min-h-11 min-w-11 rounded-input bg-sage px-3 text-sm font-semibold text-surface", focusRing)}
                    >
                      Retry
                    </button>
                  )}
                  <button
                    type="button"
                    data-testid="open-approval"
                    onClick={() => {
                      approvalStore.dismiss(r.orderId);
                      router.replace(approveHref(r.orderId));
                      router.refresh();
                    }}
                    className={cn("min-h-11 min-w-11 rounded-input border border-line px-3 text-sm font-medium text-ink", focusRing)}
                  >
                    Open
                  </button>
                </div>
              ) : null}
            </div>
            {r.status === "failed" && r.code && OVERRIDABLE_CODES.has(r.code) ? <SendAnyway row={r} /> : null}
            {r.status === "pending" ? (
              <div className="h-1 bg-line">
                <div className="h-full bg-rose transition-[width] duration-200 ease-linear" style={{ width: `${pct}%` }} />
              </div>
            ) : null}
          </div>
        );
      })}
    </>
  );
}

/**
 * Only the Stop window and a failure are shown (Yousif 2026-10-14: "it just
 * sends in the background, I don't need to see it say sending"). Sending and
 * sent rows stay in the store, so the order stays out of the queue, but are
 * never drawn; a failed send comes back with Retry / Open.
 */
function visibleRows<T extends { status: string }>(rows: T[]): T[] {
  return rows.filter((r) => r.status === "pending" || r.status === "failed");
}

/**
 * Toast for an approval the server refused because it was already checked, or
 * because the other owner had it open first (the row just goes, nothing sent).
 */
function useApprovalEvents() {
  const toast = useToast();
  useEffect(
    () =>
      approvalStore.onEvent((e) => {
        toast(
          e.type === "claimed"
            ? { variant: "warning", title: e.message, description: `${e.row.orderNumber} was not sent.` }
            : { variant: "warning", title: "Already checked", description: e.message },
        );
      }),
    [toast],
  );
}

/**
 * Desktop: a fixed stack bottom-right, above the Approve dock. On a phone the same rows sit inline
 * (PendingApprovalsInline) right above the Approve / Send back buttons.
 * `all` shows the fixed stack at every width (the "All done" page).
 */
export function PendingApprovalsHost({ all = false }: { all?: boolean }) {
  const rows = visibleRows(usePendingApprovals());
  useApprovalEvents();
  if (!rows.length) return null;
  return (
    <div
      data-testid="pending-approvals"
      className={cn(
        "fixed z-40 flex flex-col gap-2",
        all
          ? "inset-x-3 bottom-[calc(5rem+env(safe-area-inset-bottom))] lg:inset-x-auto lg:bottom-4 lg:right-4 lg:w-96"
          : "bottom-[max(1rem,calc(var(--dock-h,0px)+0.75rem))] right-4 hidden w-96 lg:flex",
      )}
    >
      <Rows rows={rows} />
    </div>
  );
}

export function PendingApprovalsInline() {
  const rows = visibleRows(usePendingApprovals());
  if (!rows.length) return null;
  return (
    <div data-testid="pending-approvals-inline" className="flex flex-col gap-2 lg:hidden">
      <Rows rows={rows} />
    </div>
  );
}
