"use client";

import { useTransition } from "react";

import { markOrderComplete } from "@/app/(app)/orders/actions";
import { Button, useToast } from "@/components/ui";
import { CheckCircle } from "@/components/ui/icons";

/** Order page "Mark complete" for a shipped or delivered order (one click). */
export function OrderCompleteButton({ orderId }: { orderId: string }) {
  const toast = useToast();
  const [pending, start] = useTransition();

  function complete() {
    start(async () => {
      const res = await markOrderComplete(orderId);
      // The action refreshes this page itself, so the status and the toast change together.
      toast({
        variant: res.ok ? "success" : "danger",
        title: res.ok ? "Order complete" : "Not completed",
        description: res.ok ? undefined : res.message,
      });
    });
  }

  return (
    <Button type="button" className="h-11 w-full shrink-0 sm:h-10 sm:w-auto" loading={pending} onClick={complete}>
      <CheckCircle size={16} />
      Mark complete
    </Button>
  );
}
