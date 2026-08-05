"use client";

import { useRef } from "react";
import { useDraggable } from "@dnd-kit/core";

import { OrderCard } from "./order-card";
import type { BoardCard } from "@/lib/orders/board-data";

export function DraggableCard({
  card,
  from,
  disabled = false,
  onOpen,
}: {
  card: BoardCard;
  from: string;
  disabled?: boolean;
  onOpen?: (card: BoardCard) => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: card.orderId,
    data: { from },
    disabled,
  });

  // Distinguish a click (open the card) from a drag: remember where the pointer
  // went down and only treat it as a click if it barely moved.
  const down = useRef<{ x: number; y: number } | null>(null);

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      onPointerDown={(e) => {
        down.current = { x: e.clientX, y: e.clientY };
      }}
      onClick={(e) => {
        const start = down.current;
        down.current = null;
        if (!onOpen || isDragging) return;
        if (start) {
          const moved = Math.hypot(e.clientX - start.x, e.clientY - start.y);
          if (moved > 5) return; // it was a drag, not a click
        }
        onOpen(card);
      }}
      className={
        disabled
          ? onOpen
            ? "cursor-pointer"
            : ""
          : "cursor-grab touch-none active:cursor-grabbing"
      }
    >
      <OrderCard card={card} dragging={isDragging} />
    </div>
  );
}
