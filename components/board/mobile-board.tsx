"use client";

import { useState } from "react";

import { Button } from "@/components/ui";
import { Brush, Check } from "@/components/ui/icons";
import { OrderCard } from "./order-card";
import type { BoardCard, DesignerBoard as BoardData } from "@/lib/orders/board-data";
import { COMPLETE_COLUMN_WINDOW_DAYS } from "@/lib/orders/board-constants";

type Cols = BoardData["columns"];
type ColKey = keyof Cols;

const SECTIONS: { key: ColKey; title: string; empty: string }[] = [
  { key: "myQueue", title: "My Queue", empty: "Nothing waiting on you." },
  { key: "inDesign", title: "In Design", empty: "Nothing in progress." },
  { key: "failedQc", title: "Failed QC, fix these first", empty: "Nothing failed." },
  { key: "revisions", title: "Revisions", empty: "No revisions." },
  { key: "awaitingQc", title: "Awaiting QC", empty: "Nothing sent for QC yet." },
  { key: "complete", title: `Complete (last ${COMPLETE_COLUMN_WINDOW_DAYS} days)`, empty: "Nothing finished yet." },
];

/**
 * Phone-first designer board: one stacked column, no drag. Each card gets a
 * big tap button for the one thing a designer actually does next — "Start"
 * moves a queued order into design, "Submit for QC" sends a designed order on
 * (the server still enforces a submission exists first; a rejection just
 * shows the same toast the desktop board shows). Awaiting QC and Complete are
 * read-only — there is nothing left for the designer to do there.
 */
export function MobileDesignerBoard({
  cols,
  onOpen,
  onStart,
  onSubmit,
}: {
  cols: Cols;
  onOpen: (card: BoardCard) => void;
  onStart: (card: BoardCard) => Promise<void>;
  onSubmit: (card: BoardCard, from: ColKey) => Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);

  async function run(card: BoardCard, action: () => Promise<void>) {
    if (busy) return;
    setBusy(card.orderId);
    try {
      await action();
    } finally {
      setBusy(null);
    }
  }

  const total = Object.values(cols).reduce((n, c) => n + c.length, 0);
  if (total === 0) {
    return (
      <div className="rounded-card border border-dashed border-line bg-surface px-4 py-10 text-center text-sm text-slate">
        No orders on your board right now.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {SECTIONS.filter((s) => cols[s.key].length > 0).map((section) => (
        <div key={section.key} className="flex flex-col gap-2.5">
          <div className="flex items-center justify-between px-0.5">
            <h2 className="text-sm font-semibold text-ink">{section.title}</h2>
            <span className="rounded-full bg-canvas px-2 py-0.5 text-xs font-medium text-slate">
              {cols[section.key].length}
            </span>
          </div>
          <div className="flex flex-col gap-3">
            {cols[section.key].map((card) => (
              <div key={card.orderId} className="flex flex-col">
                <OrderCard card={card} onOpen={() => onOpen(card)} />
                {section.key === "myQueue" && (
                  <Button
                    type="button"
                    size="lg"
                    className="mt-2 w-full"
                    loading={busy === card.orderId}
                    onClick={() => void run(card, () => onStart(card))}
                  >
                    <Brush size={16} />
                    Start
                  </Button>
                )}
                {(section.key === "inDesign" || section.key === "failedQc" || section.key === "revisions") && (
                  <Button
                    type="button"
                    size="lg"
                    variant="secondary"
                    className="mt-2 w-full"
                    loading={busy === card.orderId}
                    onClick={() => void run(card, () => onSubmit(card, section.key))}
                  >
                    <Check size={16} />
                    Submit for QC
                  </Button>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

