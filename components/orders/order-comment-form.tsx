"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { addOrderComment } from "@/app/(app)/orders/actions";
import { Button, Textarea, useToast } from "@/components/ui";

export function OrderCommentForm({ orderId }: { orderId: string }) {
  const router = useRouter();
  const toast = useToast();
  const [body, setBody] = useState("");
  const [pending, start] = useTransition();

  function submit() {
    start(async () => {
      const res = await addOrderComment(orderId, body);
      if (!res.ok) {
        toast({ variant: "danger", title: "Note not saved", description: res.message });
        return;
      }
      setBody("");
      toast({ variant: "success", title: "Note added" });
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <Textarea
        id="notes"
        label="Add internal note"
        value={body}
        onChange={(event) => setBody(event.currentTarget.value)}
        rows={3}
        placeholder="Add a VA note, customer update, designer context, or follow-up result..."
      />
      <Button
        type="button"
        size="sm"
        className="w-fit"
        loading={pending}
        disabled={!body.trim()}
        onClick={submit}
      >
        Add note
      </Button>
    </div>
  );
}
