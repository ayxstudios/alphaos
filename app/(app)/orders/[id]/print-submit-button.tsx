"use client";

import { useTransition } from "react";

import { Button, useToast } from "@/components/ui";
import { Printer } from "@/components/ui/icons";
import type { PrintProvider } from "@/lib/print/mapping";
import { submitPrintOrderAction } from "./print-actions";

/** The one tap on the "Print and ship" card: submit the prepared order to the provider. */
export function PrintSubmitButton({
  orderId,
  provider,
  label,
  requested,
  disabled = false,
}: {
  orderId: string;
  provider: PrintProvider;
  label: string;
  // True when the VA picked the other provider (the plan was re-prepared for it).
  requested: boolean;
  disabled?: boolean;
}) {
  const toast = useToast();
  const [pending, start] = useTransition();

  function submit() {
    start(async () => {
      const res = await submitPrintOrderAction(orderId, requested ? provider : null);
      toast({
        variant: res.ok ? "success" : "danger",
        title: res.ok ? "Sent to print" : "Not sent",
        description: res.message,
      });
    });
  }

  return (
    <Button
      type="button"
      className="h-11 w-full shrink-0 sm:h-10 sm:w-auto"
      loading={pending}
      disabled={disabled}
      onClick={submit}
    >
      <Printer size={16} />
      {label}
    </Button>
  );
}
