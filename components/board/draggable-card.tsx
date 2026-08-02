"use client";

import { useDraggable } from "@dnd-kit/core";

import { OrderCard } from "./order-card";
import type { BoardCard } from "@/lib/orders/board-data";

export function DraggableCard({
  card,
  from,
  disabled = false,
}: {
  card: BoardCard;
  from: string;
  disabled?: boolean;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: card.orderId,
    data: { from },
    disabled,
  });
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={disabled ? "" : "cursor-grab touch-none active:cursor-grabbing"}
    >
      <OrderCard card={card} dragging={isDragging} />
    </div>
  );
}
