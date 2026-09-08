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

import { cn } from "@/lib/utils";
import { useToast } from "@/components/ui";
import { OrderCard } from "./order-card";
import { BoardColumn } from "./board-column";
import { CardModal } from "./card-modal";
import { MobileDesignerBoard } from "./mobile-board";
import { moveOrder } from "@/app/(app)/board/actions";
import type { BoardCard, DesignerBoard as BoardData } from "@/lib/orders/board-data";
import type { OrderStatus } from "@/lib/orders/transitions";

type Cols = BoardData["columns"];
type ColKey = keyof Cols;

// Each column's representative target status (used as `to` on drop).
const COLUMN_TO_STATUS: Record<ColKey, OrderStatus> = {
  myQueue: "ready_to_assign",
  inDesign: "in_design",
  failedQc: "in_design",
  awaitingQc: "awaiting_qc",
  revisions: "in_design",
  complete: "complete",
};
const DRAG_SOURCES = new Set<ColKey>(["myQueue", "inDesign", "failedQc", "awaitingQc", "revisions"]);
const DROP_TARGETS = new Set<ColKey>(["myQueue", "inDesign", "awaitingQc"]);

const COLUMNS: { key: ColKey; title: string }[] = [
  { key: "myQueue", title: "My Queue" },
  { key: "inDesign", title: "In Design" },
  { key: "failedQc", title: "Failed QC" },
  { key: "awaitingQc", title: "Awaiting QC" },
  { key: "revisions", title: "Revisions" },
  { key: "complete", title: "Complete" },
];

export function DesignerBoard({ initial, viewerRole }: { initial: Cols; viewerRole: "admin" | "va" | "designer" }) {
  const router = useRouter();
  const toast = useToast();
  const [cols, setCols] = useState<Cols>(initial);
  const [active, setActive] = useState<BoardCard | null>(null);
  const [openCard, setOpenCard] = useState<BoardCard | null>(null);

  useEffect(() => setCols(initial), [initial]);

  // Keep the open modal's card in sync after a router.refresh reloads the board
  // (e.g. its status changed while open); close it if the card is gone.
  useEffect(() => {
    if (!openCard) return;
    for (const k of Object.keys(cols) as ColKey[]) {
      const found = cols[k].find((c) => c.orderId === openCard.orderId);
      if (found) {
        if (found !== openCard) setOpenCard(found);
        return;
      }
    }
  }, [cols, openCard]);

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

  /**
   * Move a card to `to`'s representative status. Shared by drag-and-drop (any
   * screen size) and the tap-to-act mobile buttons (no drag needed) — one
   * optimistic-update / rollback / toast path either way.
   */
  async function moveTo(card: BoardCard, from: ColKey, to: ColKey) {
    if (from === to) return;
    const prev = cols;
    setCols((c) => ({
      ...c,
      [from]: c[from].filter((x) => x.orderId !== card.orderId),
      [to]: [card, ...c[to]],
    }));

    const res = await moveOrder(card.orderId, COLUMN_TO_STATUS[to], card.status);
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

  async function onDragEnd(e: DragEndEvent) {
    setActive(null);
    const found = locate(String(e.active.id));
    const to = e.over ? (String(e.over.id) as ColKey) : null;
    if (!found || !to || !DROP_TARGETS.has(to)) return;
    await moveTo(found.card, found.col, to);
  }

  return (
    <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}>
      {/* Phone-first designer view: cards stack in one column, big Start/Submit
          buttons instead of drag. Staff (and designers on a wide screen) get
          the Trello-style drag board below. */}
      {viewerRole === "designer" && (
        <div className="lg:hidden">
          <MobileDesignerBoard
            cols={cols}
            onOpen={setOpenCard}
            onStart={(card) => moveTo(card, "myQueue", "inDesign")}
            onSubmit={(card, from) => moveTo(card, from, "awaitingQc")}
          />
        </div>
      )}
      <div className={cn("min-h-[calc(100vh-13rem)] gap-4 overflow-x-auto pb-4", viewerRole === "designer" ? "hidden lg:flex" : "flex")}>
        {COLUMNS.map((col) => (
          <BoardColumn
            key={col.key}
            id={col.key}
            title={col.title}
            cards={cols[col.key]}
            droppable={DROP_TARGETS.has(col.key)}
            draggable={DRAG_SOURCES.has(col.key)}
            onOpen={setOpenCard}
          />
        ))}
      </div>
      <DragOverlay>{active ? <OrderCard card={active} overlay /> : null}</DragOverlay>
      {openCard && <CardModal card={openCard} viewerRole={viewerRole} onClose={() => setOpenCard(null)} />}
    </DndContext>
  );
}
