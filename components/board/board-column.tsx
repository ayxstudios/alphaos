"use client";

import { useRef } from "react";
import { useDroppable } from "@dnd-kit/core";
import { useVirtualizer } from "@tanstack/react-virtual";

import { cn } from "@/lib/utils";
import { DraggableCard } from "./draggable-card";
import type { BoardCard } from "@/lib/orders/board-data";

const VIRTUALIZE_THRESHOLD = 50;

export function BoardColumn({
  id,
  title,
  cards,
  droppable,
  draggable,
}: {
  id: string;
  title: string;
  cards: BoardCard[];
  droppable: boolean; // accepts dropped cards
  draggable: boolean; // its cards can be picked up
}) {
  const { setNodeRef, isOver } = useDroppable({ id, disabled: !droppable });
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtual = cards.length > VIRTUALIZE_THRESHOLD;

  const virtualizer = useVirtualizer({
    count: cards.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 96,
    overscan: 8,
  });

  return (
    <div className="flex w-72 shrink-0 flex-col rounded-card bg-canvas">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-sm font-semibold text-ink">{title}</span>
        <span className="text-xs text-slate">{cards.length}</span>
      </div>
      <div
        ref={setNodeRef}
        className={cn(
          "min-h-24 flex-1 rounded-card border border-transparent p-1 transition-colors motion-hover",
          droppable && isOver && "border-pigment bg-pigment-soft/50",
        )}
      >
        {virtual ? (
          <div ref={scrollRef} className="max-h-[70vh] overflow-y-auto">
            <div style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}>
              {virtualizer.getVirtualItems().map((vi) => (
                <div
                  key={cards[vi.index].orderId}
                  style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${vi.start}px)`, padding: 4 }}
                >
                  <DraggableCard card={cards[vi.index]} from={id} disabled={!draggable} />
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2 p-1">
            {cards.map((c) => (
              <DraggableCard key={c.orderId} card={c} from={id} disabled={!draggable} />
            ))}
            {cards.length === 0 && (
              <p className="px-2 py-6 text-center text-xs text-slate">Empty</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
