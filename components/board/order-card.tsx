import { cn } from "@/lib/utils";
import { AlertTriangle, Camera } from "@/components/ui/icons";
import { Countdown } from "./countdown";
import { cardLabels, LABEL_CLASS } from "./card-meta";
import type { BoardCard } from "@/lib/orders/board-data";

/**
 * Presentational order card — Trello-style with a cover photo, colour labels
 * and a compact footer. Drag behaviour and click-to-open are wired by the
 * parent (`onOpen` fires on a genuine click, never at the end of a drag).
 */
export function OrderCard({
  card,
  dragging = false,
  overlay = false,
  onOpen,
}: {
  card: BoardCard;
  dragging?: boolean;
  overlay?: boolean;
  onOpen?: () => void;
}) {
  const labels = cardLabels(card);
  const revision = card.qcFail ?? card.customerRevision;
  const revisionTone = card.qcFail ? "rose" : "pigment";

  return (
    <div
      onClick={onOpen}
      className={cn(
        "group flex flex-col overflow-hidden rounded-card border border-line bg-surface transition-[box-shadow,transform,border-color] duration-150",
        overlay ? "rotate-2 shadow-lg" : "shadow-sm hover:-translate-y-0.5 hover:border-slate/40 hover:shadow-md",
        dragging && "opacity-40",
        onOpen && "cursor-pointer",
      )}
    >
      {/* Cover photo — the hero of the card. */}
      {card.thumbnailUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={card.thumbnailUrl}
          alt=""
          className="h-32 w-full object-cover"
          draggable={false}
        />
      ) : (
        <div className="flex h-16 w-full items-center justify-center gap-1.5 border-b border-dashed border-line bg-canvas text-slate">
          <Camera size={15} />
          <span className="text-xs">No photo yet</span>
        </div>
      )}

      <div className="flex flex-col gap-2 p-3">
        {labels.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {labels.map((l, i) => (
              <span
                key={i}
                className={cn(
                  "inline-flex max-w-full truncate rounded px-1.5 py-0.5 text-[11px] font-medium",
                  LABEL_CLASS[l.tone],
                )}
              >
                {l.text}
              </span>
            ))}
          </div>
        )}

        <div className="flex items-start justify-between gap-2">
          <span className="min-w-0 truncate text-sm font-semibold text-ink">
            {card.orderNumber}
          </span>
          <Countdown dueAt={card.dueAt} />
        </div>

        {card.title && (
          <p className="line-clamp-2 text-sm text-ink">{card.title}</p>
        )}

        {card.options.length > 0 && (
          <ul className="flex flex-wrap gap-1">
            {card.options.slice(0, 3).map((o, i) => (
              <li
                key={i}
                className="max-w-full truncate rounded bg-canvas px-1.5 py-0.5 text-[11px] text-slate"
              >
                <span className="text-ink">{o.name}:</span> {o.value}
              </li>
            ))}
          </ul>
        )}

        {/* Compact revision cue — the full reason + failed items live in the modal. */}
        {revision && (
          <div
            className={cn(
              "flex items-start gap-1.5 rounded-input p-2 text-xs",
              revisionTone === "rose"
                ? "border border-rose/20 bg-rose/10 text-rose"
                : "border border-pigment/20 bg-pigment-soft text-pigment",
            )}
          >
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            <span className="min-w-0">
              <span className="font-semibold">
                {card.qcFail ? "QC failed" : "Revision requested"}
              </span>
              {revision.reason && (
                <span className="line-clamp-2 font-normal italic text-slate">
                  &ldquo;{revision.reason}&rdquo;
                </span>
              )}
            </span>
          </div>
        )}

        <div className="flex items-center justify-between gap-2 border-t border-line pt-2 text-xs text-slate">
          <span className="truncate text-ink">{card.customerName}</span>
          <span className="shrink-0 tabular-nums">
            {card.figuresResolved
              ? `${card.figureCount} figure${card.figureCount === 1 ? "" : "s"}`
              : "figures: ?"}
          </span>
        </div>
      </div>
    </div>
  );
}
