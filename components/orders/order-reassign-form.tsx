"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { bulkReassignOrders } from "@/app/(app)/orders/actions";
import { Button, Select, useToast } from "@/components/ui";
import { cn } from "@/lib/utils";

export function OrderReassignForm({
  orderId,
  designers,
  assigned = true,
  inline = false,
}: {
  orderId: string;
  designers: { id: string; name: string }[];
  /** Whether the order currently has an active designer. Drives Assign vs Reassign wording. */
  assigned?: boolean;
  /** Compact horizontal layout (dropdown + button in a row, no field label). */
  inline?: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [designerId, setDesignerId] = useState("");
  const [pending, start] = useTransition();
  const verb = assigned ? "Reassign" : "Assign";

  function submit() {
    start(async () => {
      const res = await bulkReassignOrders([orderId], designerId);
      if (!res.ok) {
        toast({ variant: "danger", title: `${verb} failed`, description: res.message });
        return;
      }
      const skipped = res.skipped[0]?.reason;
      toast({
        variant: skipped ? "warning" : "success",
        title: skipped ? `Not ${verb.toLowerCase()}ed` : `Order ${verb.toLowerCase()}ed`,
        description: skipped ?? undefined,
      });
      router.refresh();
    });
  }

  return (
    <div className={cn("flex gap-2", inline ? "flex-col sm:flex-row sm:items-center" : "flex-col")}>
      <Select
        label={inline ? undefined : `${verb} designer`}
        aria-label={inline ? `${verb} designer` : undefined}
        value={designerId}
        onChange={(event) => setDesignerId(event.currentTarget.value)}
        className={inline ? "sm:w-52" : undefined}
      >
        <option value="">Choose designer</option>
        {designers.map((designer) => (
          <option key={designer.id} value={designer.id}>
            {designer.name}
          </option>
        ))}
      </Select>
      <Button
        type="button"
        size={inline ? "md" : "sm"}
        variant={inline ? "primary" : "secondary"}
        className={inline ? "shrink-0" : "w-fit"}
        loading={pending}
        disabled={!designerId}
        onClick={submit}
      >
        {inline ? verb : `${verb} order`}
      </Button>
    </div>
  );
}
