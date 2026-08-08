"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button, Input, Select, useToast } from "@/components/ui";
import { AlertTriangle, Brush } from "@/components/ui/icons";
import {
  setOrderStyleOnce,
  teachOrderStyle,
  teachOrderStyleNew,
  type StyleActionResult,
} from "@/app/(app)/orders/actions";

const NEW = "__new__";

export type OrderStyleSetterProps = {
  orderId: string;
  currentStyle: string | null;
  /** "sku"/"title" = a product-specific rule exists; "default"/"none" = no rule. */
  via: "sku" | "title" | "default" | "none";
  /** Orders that share this product (what a rule change would remap). */
  affected: number;
  styles: { id: string; name: string }[];
};

export function OrderStyleSetter({ orderId, currentStyle, via, affected, styles }: OrderStyleSetterProps) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState("");
  const [newName, setNewName] = useState("");
  const [pending, start] = useTransition();

  const hasRule = via === "sku" || via === "title";
  const targetName = choice === NEW ? newName.trim() : styles.find((s) => s.id === choice)?.name ?? "";
  const differs = !!currentStyle && !!targetName && currentStyle.toLowerCase() !== targetName.toLowerCase();
  const ready = choice === NEW ? !!newName.trim() : !!choice;

  function run(action: () => Promise<StyleActionResult>, ok: string) {
    start(async () => {
      const res = await action();
      if (!res.ok) {
        toast({ variant: "danger", title: "Didn't save", description: res.message });
        return;
      }
      toast({ variant: "success", title: ok });
      setOpen(false);
      setChoice("");
      setNewName("");
      router.refresh();
    });
  }

  const teach = () =>
    choice === NEW
      ? run(() => teachOrderStyleNew(orderId, newName.trim()), `Learned as ${newName.trim()}`)
      : run(() => teachOrderStyle(orderId, choice), `Learned as ${targetName}`);
  const once = () => run(() => setOrderStyleOnce(orderId, choice), "Style set for this order");

  const bar =
    "flex flex-wrap items-center gap-x-3 gap-y-2 rounded-card border px-4 py-3 text-sm shadow-sm";

  if (!open) {
    return (
      <div className={currentStyle ? `${bar} border-line bg-surface` : `${bar} border-amber/30 bg-amber/5`}>
        <span className="inline-flex shrink-0 items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate">
          <Brush size={14} />
          Style
        </span>
        {currentStyle ? (
          <span className="font-medium text-ink">{currentStyle}</span>
        ) : (
          <span className="font-medium text-amber">Not recognised — no style set</span>
        )}
        <Button type="button" size="sm" variant="secondary" className="ml-auto" onClick={() => setOpen(true)}>
          {currentStyle ? "Change" : "Set style"}
        </Button>
      </div>
    );
  }

  return (
    <div className={`${bar} border-line bg-surface`}>
      <div className="flex w-full flex-wrap items-center gap-2">
        <span className="inline-flex shrink-0 items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate">
          <Brush size={14} />
          Style
        </span>
        <Select value={choice} onChange={(e) => setChoice(e.currentTarget.value)} aria-label="Choose style" className="h-9 w-44">
          <option value="">Choose style…</option>
          {styles.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
          <option value={NEW}>+ New style…</option>
        </Select>
        {choice === NEW && (
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="New style name"
            aria-label="New style name"
            className="h-9 w-40"
          />
        )}
        <Button type="button" size="sm" variant="ghost" className="ml-auto" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>

      {ready && (
        <div className="w-full">
          {hasRule && differs && (
            <div className="mb-2 flex items-start gap-2 rounded-input border border-amber/30 bg-amber/5 p-2.5 text-xs text-ink">
              <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber" />
              <span>
                This product is currently learned as <strong>{currentStyle}</strong>. Changing the rule remaps{" "}
                <strong>{affected}</strong> order{affected === 1 ? "" : "s"} to <strong>{targetName}</strong>.
              </span>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" onClick={teach} loading={pending} disabled={!ready}>
              {hasRule && differs
                ? `Change rule for all ${affected} order${affected === 1 ? "" : "s"}`
                : "Teach — all future orders of this product"}
            </Button>
            {choice !== NEW && (
              <Button type="button" size="sm" variant="secondary" onClick={once} loading={pending} disabled={!ready}>
                Just this order
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
