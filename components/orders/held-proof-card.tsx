"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { sendHeldProofNowAction } from "@/app/(app)/orders/held-proof-actions";
import { Button, useToast } from "@/components/ui";
import { Clock, Mail } from "@/components/ui/icons";
import { formatAt } from "@/lib/time";

/**
 * Order page: this order passed QC, but its proof waits to go with the same
 * buyer's other order (lib/orders/deliver-together.ts). Says what it waits on
 * and when it goes at the latest; "Send now" lets it go at once. Staff only.
 */
export function HeldProofCard({
  orderId,
  waitingOn,
  holdUntil,
  canSend,
}: {
  orderId: string;
  waitingOn: { id: string; number: string }[];
  holdUntil: string;
  canSend: boolean;
}) {
  const toast = useToast();
  const router = useRouter();
  const [pending, start] = useTransition();
  const when = formatAt(holdUntil, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }, "its due time");

  function sendNow() {
    start(async () => {
      const res = await sendHeldProofNowAction(orderId);
      toast({ variant: res.ok ? "success" : "danger", title: res.ok ? "Sent" : "Not sent", description: res.message });
      if (res.ok) router.refresh();
    });
  }

  return (
    <section
      data-testid="held-proof-card"
      aria-label="Proof held"
      className="flex flex-col gap-3 rounded-card border border-amber/40 bg-amber/5 p-4 sm:flex-row sm:items-center"
    >
      <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-amber/15 text-amber">
        <Clock size={16} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-ink">
          Held: comes together with her other order{" "}
          {waitingOn.length
            ? waitingOn.map((w, i) => (
                <span key={w.id}>
                  {i > 0 ? (i === waitingOn.length - 1 ? " and " : ", ") : null}
                  <Link href={`/orders/${w.id}`} className="text-pigment underline-offset-2 hover:underline">
                    {w.number.startsWith("#") ? w.number : `#${w.number}`}
                  </Link>
                </span>
              ))
            : "(ready now, sending on the next check)"}
        </p>
        <p className="mt-0.5 break-words text-sm text-slate">
          It passed QC. It sends when that order passes QC, or at {when} at the latest, so it is never late.
        </p>
      </div>
      {canSend && (
        <Button type="button" variant="secondary" size="sm" className="h-11 w-full sm:h-9 sm:w-auto" loading={pending} onClick={sendNow} data-testid="held-proof-send-now">
          <Mail size={15} />
          Send now
        </Button>
      )}
    </section>
  );
}
