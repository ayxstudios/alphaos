"use client";

import { useRef } from "react";
import { useDroppable } from "@dnd-kit/core";
import { useVirtualizer } from "@tanstack/react-virtual";

import { cn } from "@/lib/utils";
import { DraggableCard } from "./draggable-card";
import type { BoardCard } from "@/lib/orders/board-data";

const VIRTUALIZE_THRESHOLD = 35;

export function BoardColumn({
  id,
  title,
  cards,
  droppable,
  draggable,
  onOpen,
  compact = false,
  action,
}: {
  id: string;
  title: string;
  cards: BoardCard[];
  droppable: boolean; // accepts dropped cards
  draggable: boolean; // its cards can be picked up
  onOpen?: (card: BoardCard) => void;
  /**
   * Staff boards (VA/admin): Trello-style columns — a fixed-height column
   * whose card list ALWAYS scrolls inside it (the page never grows with the
   * column), slim cards, narrower width. Designers keep the original column.
   */
  compact?: boolean;
  /** Designer boards: the card's one next-step button, rendered under it. */
  action?: (card: BoardCard) => React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id, disabled: !droppable });
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtual = cards.length > VIRTUALIZE_THRESHOLD;

  const virtualizer = useVirtualizer({
    count: cards.length,
    getScrollElement: () => scrollRef.current,
    // Only a first guess before a card has ever been measured — every
    // rendered item is re-measured for its REAL height (see measureElement
    // below), so a taller card (long revision notes, extra labels) never
    // gets covered by the next one.
    estimateSize: () => (compact ? 76 : 320),
    overscan: 6,
  });

  const list = virtual ? (
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
          data-index={vi.index}
          ref={virtualizer.measureElement}
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
            eager={vi.index < 4}
            compact={compact}
            action={action?.(cards[vi.index])}
          />
        </div>
      ))}
    </div>
  ) : (
    <div className="flex flex-col gap-2">
      {cards.map((c, i) => (
        <DraggableCard
          key={c.orderId}
          card={c}
          from={id}
          disabled={!draggable}
          onOpen={onOpen}
          eager={i < 4}
          compact={compact}
          action={action?.(c)}
        />
      ))}
      {cards.length === 0 && (
        <p className="px-2 py-8 text-center text-xs text-slate">Nothing here</p>
      )}
    </div>
  );

  return (
    <div
      className={cn(
        "flex shrink-0 flex-col overflow-hidden rounded-card bg-line/40",
        compact ? "max-h-full w-72 self-start" : "w-[min(86vw,22rem)]",
      )}
    >
      <div className="sticky top-0 z-10 flex items-center justify-between px-3 py-2.5" data-tour={`col:${id}`}>
        <span className="text-sm font-semibold text-ink">{title}</span>
        <span className="rounded-full bg-surface px-2 py-0.5 text-xs font-medium tabular-nums text-slate">
          {cards.length}
        </span>
      </div>
      <div
        ref={setNodeRef}
        className={cn(
          "min-h-32 flex-1 rounded-b-card border border-transparent p-2 transition-colors duration-150 motion-hover",
          compact && "flex min-h-0 flex-col",
          droppable && isOver && "border-pigment bg-pigment-soft/70",
        )}
      >
        <div
          ref={scrollRef}
          className={cn(
            (compact || virtual) && "overflow-y-auto pr-1",
            compact ? "min-h-0 flex-1" : virtual && "max-h-[calc(100vh-17rem)]",
          )}
        >
          {list}
        </div>
      </div>
    </div>
  );
}
