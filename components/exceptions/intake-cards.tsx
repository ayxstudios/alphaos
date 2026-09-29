"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button, Input, Select, Textarea, useToast } from "@/components/ui";
import { confirmLegacyOrderAction, pickProductDesignerAction } from "@/app/(app)/exceptions/intake-actions";

export type DesignerOption = { id: string; name: string; openCount: number };

/** "Order not in AlphaOS yet": confirm the details once Trello has been checked. */
export function LegacyConfirmForm({
  exceptionId,
  styleOptions,
  defaults,
}: {
  exceptionId: string;
  styleOptions: string[];
  defaults: { customerName: string; customerEmail: string };
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [style, setStyle] = useState("");
  const [figureCount, setFigureCount] = useState("1");
  const [productType, setProductType] = useState<"digital" | "physical">("digital");
  const [dueAt, setDueAt] = useState("");
  const [name, setName] = useState(defaults.customerName);
  const [email, setEmail] = useState(defaults.customerEmail);
  const [notes, setNotes] = useState("");

  function onConfirm() {
    start(async () => {
      const res = await confirmLegacyOrderAction({
        exceptionId,
        style,
        figureCount: figureCount ? Number(figureCount) : null,
        productType,
        dueAt,
        customerName: name,
        customerEmail: email,
        notes,
      });
      toast({ variant: res.ok ? "success" : "danger", title: res.message });
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-3 rounded-card bg-pigment-soft/40 p-3 ring-1 ring-line/70">
      <p className="text-xs font-medium text-ink">Confirm the details from Trello</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Select label="Product / style" value={style} onChange={(e) => setStyle(e.target.value)}>
          <option value="">{styleOptions.length ? "Select style" : "No styles configured"}</option>
          {styleOptions.map((s) => (
            <option key={s} value={s}>
              {s.charAt(0).toUpperCase() + s.slice(1)}
            </option>
          ))}
        </Select>
        <Input label="Size (figures)" type="number" min={1} max={20} value={figureCount} onChange={(e) => setFigureCount(e.target.value)} />
        <Select label="Product type" value={productType} onChange={(e) => setProductType(e.target.value as "digital" | "physical")}>
          <option value="digital">Digital</option>
          <option value="physical">Physical</option>
        </Select>
        <Input label="Due date" type="date" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
        <Input label="Buyer name" value={name} onChange={(e) => setName(e.target.value)} />
        <Input label="Buyer email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      <Textarea label="Notes (optional)" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} />
      <div className="flex justify-end">
        <Button type="button" size="sm" variant="primary" className="min-h-11" loading={pending} disabled={!style || !dueAt} onClick={onConfirm}>
          Confirm order
        </Button>
      </div>
    </div>
  );
}

/** "New product": choose who draws it. Saves the mapping for future orders. */
export function PickDesignerForm({ exceptionId, designers }: { exceptionId: string; designers: DesignerOption[] }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [designerId, setDesignerId] = useState("");

  function onPick() {
    start(async () => {
      const res = await pickProductDesignerAction(exceptionId, designerId);
      toast({ variant: res.ok ? "success" : "danger", title: res.message });
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-3 rounded-card bg-pigment-soft/40 p-3 ring-1 ring-line/70">
      <Select label="Who draws it?" value={designerId} onChange={(e) => setDesignerId(e.target.value)}>
        <option value="">{designers.length ? "Pick a designer" : "No designers in this business"}</option>
        {designers.map((d) => (
          <option key={d.id} value={d.id}>
            {d.name} ({d.openCount} open)
          </option>
        ))}
      </Select>
      <div className="flex justify-end">
        <Button type="button" size="sm" variant="primary" className="min-h-11" loading={pending} disabled={!designerId} onClick={onPick}>
          Save designer
        </Button>
      </div>
    </div>
  );
}
