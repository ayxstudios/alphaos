"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
import { COMPLETE_COLUMN_WINDOW_DAYS } from "@/lib/orders/board-constants";
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
  withCustomer: "awaiting_approval", // read only: never a drop target
  complete: "complete",
};
const DRAG_SOURCES = new Set<ColKey>(["myQueue", "inDesign", "failedQc", "awaitingQc", "revisions"]);
const DROP_TARGETS = new Set<ColKey>(["myQueue", "inDesign", "awaitingQc"]);

/**
 * Whether a drop is a real move. A Failed QC or Revisions card is already in
 * design, so dropping it on In Design changes nothing (the server called it an
 * "Illegal transition"). Awaiting QC back to In Design is QC's own move (a QC
 * fail, with a signed reason): it needs the QC screen, so the board leaves the
 * card where it was. Back to My Queue stays open, as the Quick guide says.
 */
function canDrop(from: ColKey, to: ColKey | null): to is ColKey {
  if (!to || from === to || !DROP_TARGETS.has(to)) return false;
  if (COLUMN_TO_STATUS[from] === COLUMN_TO_STATUS[to]) return false;
  if (from === "awaitingQc" && to === "inDesign") return false;
  return true;
}

const COLUMNS: { key: ColKey; title: string }[] = [
  { key: "myQueue", title: "My Queue" },
  { key: "inDesign", title: "In Design" },
  // Same order as the phone board: everything waiting on the designer
  // (queue, in design, failed QC, revisions) before what is waiting on others.
  { key: "failedQc", title: "Failed QC" },
  { key: "revisions", title: "Revisions" },
  { key: "awaitingQc", title: "Awaiting QC" },
  { key: "withCustomer", title: "With the Customer" },
  { key: "complete", title: `Complete (last ${COMPLETE_COLUMN_WINDOW_DAYS} days)` },
];

export function DesignerBoard({
  initial,
  viewerRole,
  timeZone,
  openId,
}: {
  initial: Cols;
  viewerRole: "admin" | "va" | "designer";
  /** The board owner's zone: a designer reads their deadline in it. */
  timeZone: string;
  /** Order to open on arrival (?open=). */
  openId?: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [cols, setCols] = useState<Cols>(initial);
  const [active, setActive] = useState<BoardCard | null>(null);
  // A card named in the URL (?open=, from a deadline on Home or My Week)
  // opens straight away.
  const [openCard, setOpenCard] = useState<BoardCard | null>(() =>
    openId ? (Object.values(initial).flat().find((c) => c.orderId === openId) ?? null) : null,
  );

  const warnedOpen = useRef<string | null>(null);
  useEffect(() => setCols(initial), [initial]);
  // The same board reached again with a different ?open= (it stays mounted).
  // An order that is not on this board (finished long ago, given to someone
  // else, or not theirs) says so instead of silently showing the board.
  useEffect(() => {
    if (!openId) return;
    const found = Object.values(initial).flat().find((c) => c.orderId === openId);
    if (found) setOpenCard(found);
    else if (warnedOpen.current !== openId) {
      warnedOpen.current = openId;
      toast({
        variant: "warning",
        title: "That order is not on this board",
        description: "It may be finished, or with another designer now.",
      });
      const url = new URL(window.location.href);
      url.searchParams.delete("open");
      window.history.replaceState(window.history.state, "", url.pathname + url.search);
    }
    // Only a new ?open= should open a card, not every refresh of `initial`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openId]);

  // Stable, so the open card's focus and scroll-lock effect does not re-run
  // (and pull focus to Close) every time the board re-renders.
  const closeCard = useCallback(() => {
    setOpenCard(null);
    // Drop ?open= quietly so a reload does not pop the card open again.
    const url = new URL(window.location.href);
    if (url.searchParams.has("open")) {
      url.searchParams.delete("open");
      window.history.replaceState(window.history.state, "", url.pathname + url.search);
    }
  }, []);

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
  async function moveTo(card: BoardCard, from: ColKey, to: ColKey): Promise<boolean> {
    if (from === to) return false;
    const prev = cols;
    // The moved card carries its new status straight away, so an open card
    // (and its buttons) updates with the board instead of after the refresh.
    const moved: BoardCard = { ...card, status: COLUMN_TO_STATUS[to], readyForQc: false };
    setCols((c) => ({
      ...c,
      [from]: c[from].filter((x) => x.orderId !== card.orderId),
      [to]: [moved, ...c[to]],
    }));

    const res = await moveOrder(card.orderId, COLUMN_TO_STATUS[to], card.status);
    if (!res.ok) {
      setCols(prev);
      toast({
        variant: "danger",
        title: res.code === "stale" ? "Already moved" : "Move failed",
        description: res.message,
      });
      return false;
    }
    if (to === "awaitingQc" && viewerRole === "designer") {
      toast({ variant: "success", title: `${card.orderNumber} sent for QC` });
    }
    router.refresh();
    return true;
  }

  async function onDragEnd(e: DragEndEvent) {
    setActive(null);
    const found = locate(String(e.active.id));
    const to = e.over ? (String(e.over.id) as ColKey) : null;
    if (!found || !canDrop(found.col, to)) return;
    await moveTo(found.card, found.col, to);
  }

  /** Submit for QC from inside the card modal (same path as the board button). */
  async function submitFromModal(card: BoardCard): Promise<boolean> {
    const found = locate(card.orderId);
    if (!found) return false;
    return moveTo(found.card, found.col, "awaitingQc");
  }

  /** Start a queued card from inside the card modal (same path as the board button). */
  async function startFromModal(card: BoardCard): Promise<boolean> {
    const found = locate(card.orderId);
    if (!found) return false;
    return moveTo(found.card, found.col, "inDesign");
  }

  // What a screen reader hears while a card is dragged: the order number and
  // the column's name (dnd-kit's defaults read out the order's database id and
  // the column key, and describe keyboard dragging this board does not offer).
  const numberOf = (id: string | number) => locate(String(id))?.card.orderNumber ?? "The card";
  const canDropFrom = (active: string | number, over: string | number) => {
    const from = locate(String(active))?.col;
    return !!from && canDrop(from, String(over) as ColKey);
  };
  const titleOf = (id: string | number) => COLUMNS.find((c) => c.key === id)?.title ?? "that column";
  const accessibility = {
    screenReaderInstructions: {
      draggable: "Press Enter to open this card. With a mouse or a finger, drag it to another column to move it.",
    },
    announcements: {
      onDragStart: ({ active }: { active: { id: string | number } }) => `Picked up ${numberOf(active.id)}.`,
      onDragOver: ({ active, over }: { active: { id: string | number }; over: { id: string | number } | null }) =>
        over ? `${numberOf(active.id)} is over ${titleOf(over.id)}.` : `${numberOf(active.id)} is not over a column.`,
      onDragEnd: ({ active, over }: { active: { id: string | number }; over: { id: string | number } | null }) =>
        over && canDropFrom(active.id, over.id)
          ? `${numberOf(active.id)} moved to ${titleOf(over.id)}.`
          : `${numberOf(active.id)} stayed where it was.`,
      onDragCancel: ({ active }: { active: { id: string | number } }) => `${numberOf(active.id)} stayed where it was.`,
    },
  };

  return (
    // A fixed id keeps dnd-kit's aria-describedby the same on the server and
    // in the browser (its counter otherwise differs: a hydration mismatch).
    <DndContext
      id="designer-board"
      sensors={sensors}
      accessibility={accessibility}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      {/* Phone-first designer view: cards stack in one column, big Start/Submit
          buttons instead of drag. Staff (and designers on a wide screen) get
          the Trello-style drag board below. */}
      {viewerRole === "designer" && (
        <div className="lg:hidden">
          <MobileDesignerBoard
            cols={cols}
            onOpen={setOpenCard}
            onStart={async (card) => void (await moveTo(card, "myQueue", "inDesign"))}
            onSubmit={async (card, from) => void (await moveTo(card, from, "awaitingQc"))}
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
      {openCard && (
        <CardModal
          card={openCard}
          viewerRole={viewerRole}
          timeZone={timeZone}
          onClose={closeCard}
          onSubmitForQc={viewerRole === "designer" ? () => submitFromModal(openCard) : undefined}
          onStart={viewerRole === "designer" ? () => startFromModal(openCard) : undefined}
        />
      )}
    </DndContext>
  );
}
