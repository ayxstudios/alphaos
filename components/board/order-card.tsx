import { cn } from "@/lib/utils";
import { Countdown } from "./countdown";
import type { BoardCard } from "@/lib/orders/board-data";

/** Presentational order card. Drag behaviour is applied by the parent. */
export function OrderCard({
  card,
  dragging = false,
  overlay = false,
}: {
  card: BoardCard;
  dragging?: boolean;
  overlay?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-card border border-line bg-surface p-3",
        overlay ? "rotate-2 shadow-lg" : "shadow-sm",
        dragging && "opacity-40",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm font-semibold text-ink">{card.platformOrderId}</span>
        <Countdown dueAt={card.dueAt} />
      </div>

      <div className="flex items-center gap-2">
        {card.thumbnailUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={card.thumbnailUrl}
            alt=""
            className="size-10 shrink-0 rounded-input border border-line object-cover"
          />
        ) : (
          <div className="flex size-10 shrink-0 items-center justify-center rounded-input border border-dashed border-line text-[10px] text-slate">
            no photo
          </div>
        )}
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-sm text-ink">{card.customerName}</span>
          <span className="truncate text-xs text-slate">
            {card.figuresResolved ? `${card.figureCount} figure${card.figureCount === 1 ? "" : "s"}` : "figures: ?"}
            {card.style ? ` · ${card.style}` : ""}
          </span>
        </div>
      </div>
    </div>
  );
}
