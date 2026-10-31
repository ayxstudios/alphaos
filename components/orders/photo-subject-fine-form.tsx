"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { markPhotoSubjectFine } from "@/app/(app)/orders/actions";
import { Button, Input, useToast } from "@/components/ui";

/**
 * Staff only: let a pet or person slot the photo check held go ahead on the
 * photos she sent ("she has no other photo, draw from photo 2"). The reason is
 * kept on the order; the designer can then hand the portrait in.
 */
export function PhotoSubjectFineForm({
  orderId,
  subjectKey,
  name,
  onMarked,
}: {
  orderId: string;
  subjectKey: string;
  name: string;
  onMarked?: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, start] = useTransition();

  function submit() {
    start(async () => {
      const res = await markPhotoSubjectFine(orderId, subjectKey, reason);
      if (!res.ok) {
        toast({ variant: "danger", title: "Not saved", description: res.message });
        return;
      }
      setOpen(false);
      setReason("");
      toast({ variant: "success", title: `${name}: photo marked fine` });
      onMarked?.();
      router.refresh();
    });
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="-my-2 inline-flex min-h-11 items-center text-xs font-medium text-pigment hover:text-ink sm:my-0 sm:min-h-0 sm:py-1"
      >
        The photo is fine
      </button>
    );
  }
  return (
    <div className="mt-2 flex flex-col gap-2">
      <Input
        label={`Why the photo of ${name} is fine`}
        value={reason}
        maxLength={300}
        autoFocus
        placeholder="She has no other photo, draw from photo 2"
        onChange={(event) => setReason(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && reason.trim().length >= 3 && !pending) submit();
        }}
      />
      <div className="flex gap-2">
        <Button type="button" size="sm" loading={pending} disabled={reason.trim().length < 3} onClick={submit}>
          Mark fine
        </Button>
        <Button type="button" size="sm" variant="secondary" disabled={pending} onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
