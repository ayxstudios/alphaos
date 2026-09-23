"use client";

import { useTransition } from "react";

import { saveShopBackfillCutoff } from "@/app/(app)/settings/actions";
import { Button, Input, useToast } from "@/components/ui";

/** A shop's live-order cutoff, saved with a confirmation (Etsy and Shopify cards). */
export function CutoffForm({ shopId, cutoffDate }: { shopId: string; cutoffDate: string }) {
  const toast = useToast();
  const [pending, start] = useTransition();

  function save(formData: FormData) {
    start(async () => {
      try {
        await saveShopBackfillCutoff(formData);
        toast({ variant: "success", title: "Cutoff saved" });
      } catch {
        toast({ variant: "danger", title: "Cutoff not saved", description: "Check the date and try again." });
      }
    });
  }

  return (
    <form action={save} className="rounded-input bg-canvas/70 p-3">
      <input type="hidden" name="shopId" value={shopId} />
      <div className="flex flex-wrap items-end gap-3">
        <Input label="Live-order cutoff" name="backfillCutoffDate" type="date" defaultValue={cutoffDate} required />
        <Button type="submit" variant="secondary" size="sm" loading={pending}>
          Save cutoff
        </Button>
      </div>
    </form>
  );
}
