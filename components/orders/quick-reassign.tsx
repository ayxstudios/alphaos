"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button, Drawer, useToast } from "@/components/ui";
import { Users } from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import { tourIsRunning } from "@/lib/tour/live";
import { loadReassignOptions, quickReassignOrder, type ReassignOption } from "@/app/(app)/orders/reassign-actions";

/**
 * "Reassign": a small panel that lists this business's designers and how many
 * open orders each one has. One tap on a name moves the order to them.
 */
export function QuickReassign({
  orderId,
  label = "Reassign",
  className,
}: {
  orderId: string;
  label?: string;
  className?: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<ReassignOption[] | null>(null);
  const [orderNumber, setOrderNumber] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loading, startLoad] = useTransition();
  const [, startMove] = useTransition();

  function show() {
    setOpen(true);
    setError(null);
    setOptions(null);
    startLoad(async () => {
      const res = await loadReassignOptions(orderId);
      if (!res.ok) return setError(res.message);
      setOrderNumber(res.orderNumber);
      setOptions(res.options);
    });
  }

  function pick(d: ReassignOption) {
    if (d.current) return;
    if (tourIsRunning()) return toast({ variant: "success", title: "That moves the order. Nothing moved in the tour." });
    setBusyId(d.id);
    setError(null);
    startMove(async () => {
      const res = await quickReassignOrder(orderId, d.id);
      setBusyId(null);
      if (!res.ok) return setError(res.message);
      toast({ variant: "success", title: `Moved to ${d.name}` });
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <>
      <button
        type="button"
        data-tour="reassign"
        onClick={show}
        className={cn(
          "inline-flex min-h-11 items-center gap-1.5 rounded-input px-2 text-sm font-medium text-pigment hover:bg-pigment-soft lg:min-h-9",
          className,
        )}
      >
        <Users size={15} aria-hidden="true" />
        {label}
      </button>
      <Drawer open={open} onClose={() => setOpen(false)} title={orderNumber ? `Reassign ${orderNumber}` : "Reassign"}>
        <p className="mb-3 text-sm text-slate">Tap a name to give this order to them.</p>
        {loading && !options && <p className="text-sm text-slate">Loading designers...</p>}
        {error && (
          <p role="alert" className="mb-3 text-sm text-rose">
            {error}
          </p>
        )}
        {options && options.length === 0 && <p className="text-sm text-slate">No designers work in this business yet.</p>}
        <ul className="flex flex-col gap-2">
          {options?.map((d) => (
            <li key={d.id}>
              <Button
                type="button"
                variant="secondary"
                size="lg"
                className="min-h-14 w-full justify-between"
                disabled={d.current || busyId !== null}
                loading={busyId === d.id}
                onClick={() => pick(d)}
              >
                <span className="min-w-0 truncate text-left">
                  {d.name}
                  {d.current && <span className="ml-2 text-xs font-normal text-slate"><span className="sr-only">, </span>has it now</span>}
                </span>
                <span className="shrink-0 text-sm font-normal text-slate">{d.openOrders} open</span>
              </Button>
            </li>
          ))}
        </ul>
      </Drawer>
    </>
  );
}
