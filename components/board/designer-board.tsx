"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";

import { useToast } from "@/components/ui";
import { OrderCard } from "./order-card";
import { BoardColumn } from "./board-column";
import { moveOrder } from "@/app/(app)/board/actions";
import type { BoardCard, DesignerBoard as BoardData } from "@/lib/orders/board-data";
import type { OrderStatus } from "@/lib/orders/transitions";

type Cols = BoardData["columns"];
type ColKey = keyof Cols;

// Each column's representative target status (used as `to` on drop).
const COLUMN_TO_STATUS: Record<ColKey, OrderStatus> = {
  myQueue: "ready_to_assign",
  inDesign: "in_design",
  awaitingQc: "awaiting_qc",
  revisions: "in_design",
  complete: "complete",
};
// A designer's only legal moves: start (My Queue → In Design) and submit
// (In Design → Awaiting QC). So only these columns drag/drop.
const DRAG_SOURCES = new Set<ColKey>(["myQueue", "inDesign"]);
const DROP_TARGETS = new Set<ColKey>(["inDesign", "awaitingQc"]);

const COLUMNS: { key: ColKey; title: string }[] = [
  { key: "myQueue", title: "My Queue" },
  { key: "inDesign", title: "In Design" },
  { key: "awaitingQc", title: "Awaiting QC" },
  { key: "revisions", title: "Revisions" },
  { key: "complete", title: "Complete" },
];

export function DesignerBoard({ initial }: { initial: Cols }) {
  const router = useRouter();
  const toast = useToast();
  const [cols, setCols] = useState<Cols>(initial);
  const [active, setActive] = useState<BoardCard | null>(null);

  useEffect(() => setCols(initial), [initial]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  function locate(id: string): { card: BoardCard; col: ColKey } | null {
    for (const k of Object.keys(cols) as ColKey[]) {
      const card = cols[k].find((c) => c.orderId === id);
      if (card) return { card, col: k };
    }
    return null;
  }

  function onDragStart(e: DragStartEvent) {
    setActive(locate(String(e.active.id))?.card ?? null);
  }

  async function onDragEnd(e: DragEndEvent) {
    setActive(null);
    const found = locate(String(e.active.id));
    const to = e.over ? (String(e.over.id) as ColKey) : null;
    if (!found || !to || found.col === to || !DROP_TARGETS.has(to)) return;

    const prev = cols;
    setCols((c) => ({
      ...c,
      [found.col]: c[found.col].filter((x) => x.orderId !== found.card.orderId),
      [to]: [found.card, ...c[to]],
    }));

    const res = await moveOrder(found.card.orderId, COLUMN_TO_STATUS[to], found.card.status);
    if (!res.ok) {
      setCols(prev);
      toast({
        variant: "danger",
        title: res.code === "stale" ? "Already moved" : "Move failed",
        description: res.message,
      });
    } else {
      router.refresh();
    }
  }

  return (
    <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}>
      <div className="flex gap-3 overflow-x-auto pb-4">
        {COLUMNS.map((col) => (
          <BoardColumn
            key={col.key}
            id={col.key}
            title={col.title}
            cards={cols[col.key]}
            droppable={DROP_TARGETS.has(col.key)}
            draggable={DRAG_SOURCES.has(col.key)}
          />
        ))}
      </div>
      <DragOverlay>{active ? <OrderCard card={active} overlay /> : null}</DragOverlay>
    </DndContext>
  );
}
