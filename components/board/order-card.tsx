import { cn } from "@/lib/utils";
import { AlertTriangle } from "@/components/ui/icons";
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

      {card.qcFail && (
        <div className="flex flex-col gap-1 rounded-input border border-rose/20 bg-rose/10 p-2">
          <span className="flex items-center gap-1.5 text-xs font-semibold text-rose">
            <AlertTriangle size={13} className="shrink-0" /> QC failed — fix &amp; resubmit
          </span>
          {card.qcFail.failedItems.length > 0 && (
            <ul className="ml-1 list-inside list-disc text-xs text-ink">
              {card.qcFail.failedItems.map((label, i) => (
                <li key={i} className="truncate">{label}</li>
              ))}
            </ul>
          )}
          {card.qcFail.reason && (
            <p className="text-xs italic text-slate">&ldquo;{card.qcFail.reason}&rdquo;</p>
          )}
        </div>
      )}

      {card.customerRevision && (
        <div className="flex flex-col gap-1 rounded-input border border-pigment/20 bg-pigment-soft p-2">
          <span className="flex items-center gap-1.5 text-xs font-semibold text-pigment">
            <AlertTriangle size={13} className="shrink-0" /> Customer requested changes
          </span>
          {card.customerRevision.failedItems.length > 0 && (
            <ul className="ml-1 list-inside list-disc text-xs text-ink">
              {card.customerRevision.failedItems.map((label, i) => (
                <li key={i} className="truncate">{label}</li>
              ))}
            </ul>
          )}
          {card.customerRevision.reason && (
            <p className="text-xs italic text-slate">
              &ldquo;{card.customerRevision.reason}&rdquo;
            </p>
          )}
        </div>
      )}
    </div>
  );
}
