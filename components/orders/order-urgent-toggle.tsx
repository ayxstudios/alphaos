"use client";

import { useState, useTransition } from "react";

import { setUrgent } from "@/app/(app)/orders/actions";
import { Button, ConfirmDrawer, Input, useToast } from "@/components/ui";
import { AlertTriangle, X } from "@/components/ui/icons";
import { UrgentPill } from "@/components/orders/urgent-pill";

/**
 * Order page header: "Mark urgent" (a buyer is chasing a stalled or legacy
 * order) with an optional reason, or the Urgent pill plus "Clear urgent".
 * Admin and VAs only (the page only renders it for staff; the action checks
 * again). Urgent orders sort first on every board, list and queue.
 */
export function OrderUrgentToggle({
  orderId,
  urgent,
  reason,
  hasDueDate,
}: {
  orderId: string;
  urgent: boolean;
  reason: string | null;
  hasDueDate: boolean;
}) {
  const toast = useToast();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");

  function apply(next: boolean, why?: string) {
    start(async () => {
      const res = await setUrgent(orderId, next, why);
      toast({
        variant: res.ok ? "success" : "danger",
        title: res.ok ? (next ? "Marked urgent" : "No longer urgent") : "Not changed",
        description: res.ok ? undefined : res.message,
      });
      if (res.ok) setText("");
    });
  }

  if (urgent) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <UrgentPill reason={reason} className="h-6 px-2 text-sm" />
        <Button type="button" variant="ghost" size="sm" loading={pending} onClick={() => apply(false)} title="Clear urgent">
          <X size={14} />
          <span className="max-[399px]:sr-only">Clear urgent</span>
        </Button>
      </span>
    );
  }

  return (
    <>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="h-11 sm:h-9"
        loading={pending}
        onClick={() => setOpen(true)}
        data-testid="mark-urgent"
      >
        <AlertTriangle size={15} />
        Mark urgent
      </Button>
      <ConfirmDrawer
        open={open}
        onClose={() => setOpen(false)}
        onConfirm={() => apply(true, text)}
        title="Mark this order urgent?"
        confirmLabel="Mark urgent"
        danger
      >
        <p className="text-base text-slate">
          It goes to the top of the designer&apos;s board, Awaiting QC and Today, and the agent works it even if it is an
          older order.{" "}
          {hasDueDate ? "The due date stays as it is." : "It has no due date yet, so it gets one 24 hours from now."}
        </p>
        <Input
          label="Why (optional)"
          placeholder="e.g. Buyer chasing, legacy order"
          value={text}
          maxLength={300}
          onChange={(e) => setText(e.target.value)}
        />
      </ConfirmDrawer>
    </>
  );
}
