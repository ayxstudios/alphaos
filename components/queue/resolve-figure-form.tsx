"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button, Input } from "@/components/ui";
import { setItemFigureCount } from "@/app/(app)/queue/review/actions";

export function ResolveFigureForm({ orderItemId }: { orderItemId: string }) {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onSave() {
    setError(null);
    const count = Number(value);
    if (!Number.isInteger(count) || count < 1) {
      setError("Enter a whole number ≥ 1");
      return;
    }
    startTransition(async () => {
      try {
        await setItemFigureCount(orderItemId, count);
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to save");
      }
    });
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-end gap-2">
        <div className="w-28">
          <Input
            label="Figure count"
            type="number"
            min={1}
            max={50}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="e.g. 3"
          />
        </div>
        <Button size="sm" onClick={onSave} loading={pending}>
          Save
        </Button>
      </div>
      {error && <p className="text-xs text-rose">{error}</p>}
    </div>
  );
}
