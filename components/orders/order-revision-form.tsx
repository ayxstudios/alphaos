"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { createOrderRevision } from "@/app/(app)/orders/actions";
import { Button, Textarea, useToast } from "@/components/ui";

export function OrderRevisionForm({
  orderId,
  initialNote = "",
  buttonLabel = "Create revision",
  disabled = false,
}: {
  orderId: string;
  initialNote?: string;
  buttonLabel?: string;
  disabled?: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [note, setNote] = useState(initialNote);
  const [pending, start] = useTransition();

  function submit() {
    start(async () => {
      const res = await createOrderRevision(orderId, note);
      if (!res.ok) {
        toast({ variant: "danger", title: "Revision not created", description: res.message });
        return;
      }
      toast({ variant: "success", title: "Revision created" });
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <Textarea
        label="Revision request"
        value={note}
        onChange={(event) => setNote(event.currentTarget.value)}
        rows={3}
        disabled={disabled || pending}
        placeholder="Describe exactly what the designer must change..."
      />
      <Button
        type="button"
        size="sm"
        variant="danger"
        className="w-fit"
        loading={pending}
        disabled={disabled || !note.trim()}
        onClick={submit}
      >
        {buttonLabel}
      </Button>
    </div>
  );
}
