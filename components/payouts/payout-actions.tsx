"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button, Drawer, Input, useToast } from "@/components/ui";
import {
  markPeriodPaidAction,
  resolveBlockedEarningAction,
  voidEarningAction,
  type ActionResult,
} from "@/app/(app)/payouts/actions";

function useRunAction() {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();

  function run(action: () => Promise<ActionResult>, okTitle = "Updated") {
    start(async () => {
      let result: ActionResult;
      try {
        result = await action();
      } catch {
        result = { ok: false, message: "Could not save. Try again in a moment." };
      }
      toast({
        variant: result.ok ? "success" : "danger",
        title: result.ok ? okTitle : "Didn't update",
        description: result.message,
      });
      if (result.ok) router.refresh();
    });
  }

  return { pending, run };
}

export function ResolveBlockedButton({
  businessId,
  earningId,
}: {
  businessId: string;
  earningId: string;
}) {
  const { pending, run } = useRunAction();
  return (
    <Button
      type="button"
      size="sm"
      loading={pending}
      onClick={() => run(() => resolveBlockedEarningAction(earningId, businessId))}
    >
      Resolve
    </Button>
  );
}

export function MarkPeriodPaidButton({
  businessId,
  designerId,
  period,
  designerName,
  pendingLabel,
  pendingCount,
}: {
  businessId: string;
  designerId: string;
  period: string;
  designerName: string;
  /** The pending total, already formatted (e.g. "$16.00"). */
  pendingLabel: string;
  pendingCount: number;
}) {
  const { pending, run } = useRunAction();
  const [open, setOpen] = useState(false);
  const orders = `${pendingCount} order${pendingCount === 1 ? "" : "s"}`;
  return (
    <>
      <Button type="button" size="sm" variant="secondary" loading={pending} onClick={() => setOpen(true)}>
        Mark paid
      </Button>
      {/* Paying is not undone from here, so say exactly who and how much. */}
      <Drawer open={open} onClose={() => setOpen(false)} title="Mark paid">
        <div className="flex flex-col gap-4">
          <p className="text-sm text-ink">
            Record <span className="font-semibold">{pendingLabel}</span> as paid to{" "}
            <span className="font-semibold">{designerName}</span> for {orders} in {monthName(period)}?
          </p>
          <p className="text-sm text-slate">Pay them first. This only records it, and it cannot be undone here.</p>
          <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="ghost" className="min-h-11 sm:min-h-0" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              className="min-h-11 sm:min-h-0"
              onClick={() => {
                setOpen(false);
                run(() => markPeriodPaidAction(businessId, designerId, period), `Marked ${pendingLabel} paid`);
              }}
            >
              Mark {pendingLabel} paid
            </Button>
          </div>
        </div>
      </Drawer>
    </>
  );
}

/** "2026-09" -> "September 2026". */
function monthName(period: string): string {
  const [y, m] = period.split("-").map(Number);
  if (!y || !m) return period;
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en-AU", { month: "long", year: "numeric", timeZone: "UTC" });
}

export function VoidEarningForm({
  businessId,
  earningId,
}: {
  businessId: string;
  earningId: string;
}) {
  const [reason, setReason] = useState("");
  const { pending, run } = useRunAction();
  return (
    <div className="flex min-w-0 items-center gap-2">
      <Input
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Void reason"
        aria-label="Void reason"
        className="h-10 w-40 sm:h-8"
      />
      <Button
        type="button"
        size="sm"
        variant="ghost"
        loading={pending}
        disabled={!reason.trim()}
        onClick={() => run(() => voidEarningAction(businessId, earningId, reason))}
      >
        Void
      </Button>
    </div>
  );
}
