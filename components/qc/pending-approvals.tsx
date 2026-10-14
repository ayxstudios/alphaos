"use client";

import { useRouter } from "next/navigation";
import { PrefetchKind } from "next/dist/client/components/router-reducer/router-reducer-types";
import { useEffect, useState, useSyncExternalStore } from "react";

import { ownerApprove } from "@/app/(app)/approve/actions";
import { useToast } from "@/components/ui";
import { focusRing } from "@/components/ui/styles";
import { cn } from "@/lib/utils";
import {
  APPROVE_GRACE_MS,
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

async function viaRoute(orderId: string, keepalive: boolean): Promise<CommitResult> {
  const res = await fetch("/api/approve/commit", {
    method: "POST",
    keepalive,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orderId }),
  });
  return (await res.json()) as CommitResult;
}

// Same protections the screen's callAction always had (Yousif 2026-10-14): a
// dropped connection or a 55 s stall ends with a reason, and a retry is safe
// because the server answers "Already checked" when the first one landed.
async function commit(orderId: string): Promise<CommitResult> {
  try {
    return await Promise.race([
      ownerApprove(orderId),
      new Promise<never>((_, fail) => setTimeout(() => fail(new Error("timeout")), COMMIT_TIMEOUT_MS)),
    ]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // The page is older than the live app (its server action id is gone): the
    // plain route does the same approve and needs no matching bundle.
    if (/server action/i.test(msg)) {
      try {
        return await viaRoute(orderId, false);
      } catch {
        return { ok: false, code: "network", message: "AlphaOS was just updated. Tap Retry." };
      }
    }
    return {
      ok: false,
      code: msg === "timeout" ? "timeout" : "network",
      message:
        msg === "timeout"
          ? "No answer after a minute, it may not have gone through."
          : "That didn't go through (connection dropped).",
    };
  }
}

// The store lives at module level so rows (and their timers) survive the
// router.replace + refresh that remounts the screen after every Approve.
export const approvalStore = createApprovalStore({
  commit,
  beacon: (orderId) => viaRoute(orderId, true),
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
export function approveHref(orderId: string | null, exclude?: string, also?: string): string {
  const skip = approvalStore.skipIds().filter((id) => id !== exclude);
  if (also && also !== exclude && !skip.includes(also)) skip.push(also);
  const q = new URLSearchParams();
  if (orderId) q.set("o", orderId);
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
                    <span className="font-semibold">Approving {r.orderNumber}</span>
                    <span className="text-slate"> · sends in {Math.ceil(left / 1000)} s</span>
                  </>
                ) : r.status === "sending" ? (
                  <span className="font-semibold">Sending {r.orderNumber}...</span>
                ) : r.status === "sent" ? (
                  <span className="font-semibold text-sage">Sent to {firstName(r.customerName)}</span>
                ) : (
                  <>
                    <span className="font-semibold">{r.orderNumber} not sent.</span>
                    <span className="text-slate"> {r.message}</span>
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
                  <button
                    type="button"
                    data-testid="retry-approval"
                    onClick={() => approvalStore.retry(r.orderId)}
                    className={cn("min-h-11 min-w-11 rounded-input bg-sage px-3 text-sm font-semibold text-surface", focusRing)}
                  >
                    Retry
                  </button>
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

/** Toast for an approval the server said was already checked (the row just goes). */
function useApprovalEvents() {
  const toast = useToast();
  useEffect(
    () =>
      approvalStore.onEvent((e) => {
        toast({ variant: "warning", title: "Already checked", description: e.message });
      }),
    [toast],
  );
}

/**
 * Desktop: a fixed stack bottom-right. On a phone the same rows sit inline
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
          : "bottom-4 right-4 hidden w-96 lg:flex",
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
