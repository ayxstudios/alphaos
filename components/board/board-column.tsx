"use client";

import { useRef } from "react";
import { useDroppable } from "@dnd-kit/core";
import { useVirtualizer } from "@tanstack/react-virtual";

import { cn } from "@/lib/utils";
import { DraggableCard } from "./draggable-card";
import type { BoardCard } from "@/lib/orders/board-data";

const VIRTUALIZE_THRESHOLD = 35;

export type ColumnTone = "neutral" | "pigment" | "amber" | "rose" | "sage";

const TONE_ACCENT: Record<ColumnTone, string> = {
  neutral: "bg-line",
  pigment: "bg-pigment",
  amber: "bg-amber",
  rose: "bg-rose",
  sage: "bg-sage",
};

const TONE_COUNT: Record<ColumnTone, string> = {
  neutral: "bg-canvas text-slate",
  pigment: "bg-pigment-soft text-pigment",
  amber: "bg-amber/10 text-amber",
  rose: "bg-rose/10 text-rose",
  sage: "bg-sage/10 text-sage",
};

export function BoardColumn({
  id,
  title,
  cards,
  droppable,
  draggable,
  onOpen,
  tone = "neutral",
}: {
  id: string;
  title: string;
  cards: BoardCard[];
  droppable: boolean; // accepts dropped cards
  draggable: boolean; // its cards can be picked up
  onOpen?: (card: BoardCard) => void;
  tone?: ColumnTone;
}) {
  const { setNodeRef, isOver } = useDroppable({ id, disabled: !droppable });
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtual = cards.length > VIRTUALIZE_THRESHOLD;

  const virtualizer = useVirtualizer({
    count: cards.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 320,
    overscan: 6,
  });

  return (
    <div className="flex w-[min(86vw,24rem)] shrink-0 flex-col overflow-hidden rounded-card border border-line bg-canvas shadow-sm">
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-line bg-surface px-4 py-3">
        <span className="flex items-center gap-2 text-sm font-semibold text-ink">
          <span
            className={cn("size-1.5 shrink-0 rounded-full", TONE_ACCENT[tone])}
            aria-hidden="true"
          />
          {title}
        </span>
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-xs font-medium tabular-nums",
            TONE_COUNT[tone],
          )}
        >
          {cards.length}
        </span>
      </div>
      <div
        ref={setNodeRef}
        className={cn(
          "min-h-32 flex-1 border border-transparent bg-canvas/80 p-2 transition-colors duration-150 motion-hover",
          droppable && "border-dashed border-line",
          droppable && isOver && "border-pigment bg-pigment-soft/70",
        )}
      >
        {virtual ? (
          <div ref={scrollRef} className="max-h-[calc(100vh-17rem)] overflow-y-auto pr-1">
            <div
              style={{
                height: virtualizer.getTotalSize(),
                position: "relative",
                width: "100%",
              }}
            >
              {virtualizer.getVirtualItems().map((vi) => (
                <div
                  key={cards[vi.index].orderId}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${vi.start}px)`,
                    padding: 5,
                  }}
                >
                  <DraggableCard
                    card={cards[vi.index]}
                    from={id}
                    disabled={!draggable}
                    onOpen={onOpen}
                  />
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {cards.map((c) => (
              <DraggableCard
                key={c.orderId}
                card={c}
                from={id}
                disabled={!draggable}
                onOpen={onOpen}
              />
            ))}
            {cards.length === 0 && (
              <p className="rounded-input border border-dashed border-line bg-surface px-2 py-8 text-center text-xs text-slate">Empty</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
