"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button, Input, useToast } from "@/components/ui";
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
      const result = await action();
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
  const orders = `${pendingCount} order${pendingCount === 1 ? "" : "s"}`;
  return (
    <Button
      type="button"
      size="sm"
      variant="secondary"
      loading={pending}
      onClick={() => {
        // Paying is not undone from here, so say exactly who and how much.
        if (confirm(`Mark ${pendingLabel} for ${designerName} (${orders}, ${period}) as paid? Pay them first; this only records it.`)) {
          run(() => markPeriodPaidAction(businessId, designerId, period), `Marked ${pendingLabel} paid`);
        }
      }}
    >
      Mark paid
    </Button>
  );
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
    <div className="flex flex-wrap items-center gap-2">
      <Input
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Void reason"
        aria-label="Void reason"
        className="h-8 w-44"
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
