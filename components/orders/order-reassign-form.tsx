"use client";

import { useState, useTransition } from "react";

import { bulkReassignOrders } from "@/app/(app)/orders/actions";
import { Button, Select, useToast } from "@/components/ui";
import { PhotoHoldReason } from "./photo-hold-reason";
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
  const toast = useToast();
  const [designerId, setDesignerId] = useState("");
  const [pending, start] = useTransition();
  /** The refusal for a pet with no clear face photo: shown with a box for the reason to go on. */
  const [held, setHeld] = useState<string | null>(null);
  const verb = assigned ? "Reassign" : "Assign";

  function submit(reason?: string) {
    start(async () => {
      const res = await bulkReassignOrders([orderId], designerId, reason);
      if (!res.ok) {
        toast({ variant: "danger", title: `${verb} failed`, description: res.message });
        return;
      }
      if (res.skipped[0]?.code === "photo_subject_missing") {
        setHeld(res.skipped[0].reason);
        return;
      }
      setHeld(null);
      const skipped = res.skipped[0]?.reason;
      toast({
        variant: skipped ? "warning" : "success",
        title: skipped ? `Not ${verb.toLowerCase()}ed` : `Order ${verb.toLowerCase()}ed`,
        description: skipped ?? undefined,
      });
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
        onClick={() => submit()}
      >
        {inline ? verb : `${verb} order`}
      </Button>
      {held && <PhotoHoldReason message={held} pending={pending} onAssign={(reason) => submit(reason)} onCancel={() => setHeld(null)} />}
    </div>
  );
}
