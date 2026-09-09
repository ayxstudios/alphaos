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
  eager = false,
}: {
  card: BoardCard;
  dragging?: boolean;
  overlay?: boolean;
  onOpen?: () => void;
  /** First few cards above the fold: skip lazy-loading so they paint immediately. */
  eager?: boolean;
}) {
  const labels = cardLabels(card);
  const revision = card.qcFail ?? card.customerRevision;
  const revisionTone = card.qcFail ? "rose" : "pigment";

  return (
    <div
      onClick={onOpen}
      className={cn(
        "group flex flex-col overflow-hidden rounded-card bg-surface transition-[box-shadow,transform] duration-150",
        overlay ? "rotate-2 shadow-lg" : "shadow-card hover:-translate-y-0.5 hover:shadow-md",
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
          className="h-32 w-full bg-canvas object-cover"
          draggable={false}
          loading={eager ? "eager" : "lazy"}
          decoding="async"
          fetchPriority={eager ? "high" : "auto"}
        />
      ) : (
        <div className="flex h-16 w-full items-center justify-center gap-1.5 bg-canvas text-slate">
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
                  "inline-flex max-w-full truncate rounded px-1.5 py-0.5 text-xs font-medium",
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
                className="max-w-full truncate rounded bg-canvas px-1.5 py-0.5 text-xs text-slate"
              >
                <span className="text-ink">{o.name}:</span> {o.value}
              </li>
            ))}
          </ul>
        )}

        {/* Compact revision cue — the full detail lives in the modal, but the
            failed items + pin count show right here so a designer doesn't
            have to open the card just to see what to fix. */}
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
              {revision.failedItems.length > 0 && (
                <ul className="ml-3 list-outside list-disc font-normal text-ink">
                  {revision.failedItems.slice(0, 2).map((f, i) => (
                    <li key={i} className="line-clamp-1">
                      {f}
                    </li>
                  ))}
                  {revision.failedItems.length > 2 && (
                    <li className="text-slate">+{revision.failedItems.length - 2} more</li>
                  )}
                </ul>
              )}
              {revision.reason && (
                <span className="line-clamp-2 font-normal italic text-slate">
                  &ldquo;{revision.reason}&rdquo;
                </span>
              )}
              {!!revision.annotations?.length && (
                <span className="mt-0.5 block font-normal text-slate">
                  {revision.annotations.length} pin{revision.annotations.length === 1 ? "" : "s"} on the image
                </span>
              )}
            </span>
          </div>
        )}

        <div className="flex items-center justify-between gap-2 border-t border-line/70 pt-2 text-xs text-slate">
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
