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

  function run(action: () => Promise<ActionResult>) {
    start(async () => {
      const result = await action();
      toast({
        variant: result.ok ? "success" : "danger",
        title: result.ok ? "Updated" : "Didn't update",
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
}: {
  businessId: string;
  designerId: string;
  period: string;
}) {
  const { pending, run } = useRunAction();
  return (
    <Button
      type="button"
      size="sm"
      variant="secondary"
      loading={pending}
      onClick={() => {
        if (confirm("Mark this designer's pending earnings for this period as paid?")) {
          run(() => markPeriodPaidAction(businessId, designerId, period));
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
