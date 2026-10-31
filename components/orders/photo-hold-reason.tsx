"use client";

import { useState } from "react";

import { Button } from "@/components/ui";
import { AlertTriangle } from "@/components/ui/icons";

/** A few words is enough, as for "The photo is fine". */
const MIN_REASON = 3;

/**
 * An order with a pet or person that has no clear face photo is not given to a
 * designer (Yousif 2026-10-31). The refusal names the pet; admin and va can go
 * on by saying why, and the reason is logged on the order.
 */
export function PhotoHoldReason({
  message,
  pending,
  onAssign,
  onCancel,
}: {
  message: string;
  pending?: boolean;
  onAssign: (reason: string) => void;
  onCancel?: () => void;
}) {
  const [reason, setReason] = useState("");
  const ok = reason.trim().length >= MIN_REASON;
  return (
    <div role="alert" className="flex flex-col gap-2 rounded-input border border-amber bg-surface px-3 py-2 text-sm text-ink">
      <p className="flex items-start gap-2">
        <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber" aria-hidden />
        <span className="min-w-0 break-words [overflow-wrap:anywhere]">{message}</span>
      </p>
      <label className="flex flex-col gap-1 text-xs font-semibold text-slate">
        To give it to a designer anyway, say why
        <textarea
          value={reason}
          onChange={(event) => setReason(event.currentTarget.value)}
          rows={2}
          maxLength={500}
          className="rounded-input border border-line bg-surface px-2 py-1.5 text-sm font-normal text-ink"
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="secondary" loading={pending} disabled={!ok} onClick={() => onAssign(reason.trim())}>
          Assign anyway
        </Button>
        {onCancel && (
          <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={onCancel}>
            Wait for the photo
          </Button>
        )}
      </div>
    </div>
  );
}
