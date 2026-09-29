"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button, Textarea, useToast } from "@/components/ui";
import { resolveExceptionAction } from "@/app/(app)/exceptions/actions";

export function ResolveButton({ id }: { id: string }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [pending, start] = useTransition();

  function onResolve() {
    start(async () => {
      const res = await resolveExceptionAction(id, note);
      if (res.ok) {
        toast({ variant: "success", title: "Marked resolved" });
      } else {
        toast({ variant: "danger", title: res.message });
      }
      router.refresh();
    });
  }

  if (!open) {
    return (
      <Button type="button" size="sm" variant="secondary" className="min-h-11" onClick={() => setOpen(true)}>
        Resolve
      </Button>
    );
  }
  return (
    <div className="flex w-full flex-col gap-2">
      <Textarea
        label="Note (optional)"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={2}
        maxLength={500}
        placeholder="What you did, so the agent can learn from it"
      />
      <div className="flex gap-2">
        <Button type="button" size="sm" variant="primary" className="min-h-11" loading={pending} onClick={onResolve}>
          Mark resolved
        </Button>
        <Button type="button" size="sm" variant="secondary" className="min-h-11" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
