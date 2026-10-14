"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { useToast } from "@/components/ui";
import type { ClaimAnswer } from "@/lib/qc/claims";
import { approvalStore, approveHref } from "./pending-approvals";

// Mirrors CLAIM_HEARTBEAT_MS in lib/qc/claims.ts (kept out of the client bundle's imports).
const HEARTBEAT_MS = 30_000;

async function post(
  orderId: string,
  op: "claim" | "release",
  keepalive = false,
): Promise<ClaimAnswer | null> {
  try {
    const res = await fetch("/api/approve/claim", {
      method: "POST",
      keepalive,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderId, op }),
    });
    return (await res.json()) as ClaimAnswer;
  } catch {
    return null; // offline for a moment: the next beat tries again
  }
}

/** Let go of an order (Skip): it goes back in the pile for the other owner. */
export function releaseClaim(orderId: string) {
  if (inFlight(orderId)) return;
  void post(orderId, "release", true);
}

// An approval in its Stop window or on its way keeps the order held, so the
// other owner cannot pick it up between the tap and the send.
function inFlight(orderId: string): boolean {
  return approvalStore
    .getRows()
    .some(
      (r) =>
        r.orderId === orderId &&
        (r.status === "pending" || r.status === "sending"),
    );
}

/**
 * Two owners on /approve (lib/qc/claims.ts): this order is mine while it is on
 * my screen. Claimed on open and refreshed every 30 s while the page is
 * visible (a locked phone stops refreshing, and after 3 minutes the order is
 * back in the pile). If someone else already has it, or it was checked in the
 * meantime, say so and move on to the next one.
 */
export function useApproveClaim(orderId: string, orderNumber: string) {
  const router = useRouter();
  const toast = useToast();
  useEffect(() => {
    let alive = true;
    let lost = false;
    async function beat() {
      if (lost || document.visibilityState !== "visible") return;
      const res = await post(orderId, "claim");
      if (!alive || lost || !res || res.ok) return;
      if (res.code !== "claimed" && res.code !== "stale") return;
      lost = true;
      toast(
        res.code === "claimed"
          ? {
              variant: "info",
              title: `${res.holder} is checking ${orderNumber}`,
              description: "Here is the next one.",
            }
          : {
              variant: "info",
              title: "Already checked",
              description: `${orderNumber} was just checked. Here is the next one.`,
            },
      );
      router.replace(approveHref(null));
      router.refresh();
    }
    void beat();
    const timer = setInterval(() => void beat(), HEARTBEAT_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void beat();
    };
    // Closing the tab or leaving the site: hand the order back at once.
    const onHide = () => {
      if (!lost) releaseClaim(orderId);
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pagehide", onHide);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pagehide", onHide);
    };
  }, [orderId, orderNumber, router, toast]);
}
