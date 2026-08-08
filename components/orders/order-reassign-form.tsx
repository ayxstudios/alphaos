"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { bulkReassignOrders } from "@/app/(app)/orders/actions";
import { Button, Select, useToast } from "@/components/ui";

export function OrderReassignForm({
  orderId,
  designers,
  assigned = true,
}: {
  orderId: string;
  designers: { id: string; name: string }[];
  /** Whether the order currently has an active designer. Drives Assign vs Reassign wording. */
  assigned?: boolean;
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
    <div className="flex flex-col gap-2">
      <Select
        label={`${verb} designer`}
        value={designerId}
        onChange={(event) => setDesignerId(event.currentTarget.value)}
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
        size="sm"
        variant="secondary"
        className="w-fit"
        loading={pending}
        disabled={!designerId}
        onClick={submit}
      >
        {verb} order
      </Button>
    </div>
  );
}
