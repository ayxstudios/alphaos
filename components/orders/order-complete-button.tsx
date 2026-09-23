"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";

import { markOrderComplete } from "@/app/(app)/orders/actions";
import { Button, useToast } from "@/components/ui";
import { CheckCircle } from "@/components/ui/icons";

/** Order page "Mark complete" for a shipped or delivered order (one click). */
export function OrderCompleteButton({ orderId }: { orderId: string }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();

  function complete() {
    start(async () => {
      const res = await markOrderComplete(orderId);
      toast({
        variant: res.ok ? "success" : "danger",
        title: res.ok ? "Marked complete" : "Not completed",
        description: res.message,
      });
      if (res.ok) router.refresh();
    });
  }

  return (
    <Button type="button" className="h-10 w-full shrink-0 sm:w-auto" loading={pending} onClick={complete}>
      <CheckCircle size={16} />
      Mark complete
    </Button>
  );
}
