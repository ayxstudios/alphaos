/* eslint-disable @next/next/no-img-element -- artwork thumbnails are signed R2/CDN urls of any size */

import Link from "next/link";

import { Badge } from "@/components/ui";
import { Users } from "@/components/ui/icons";
import type { SameBuyerCardOrder, SameBuyerView } from "@/lib/orders/same-buyer-view";
import { cn } from "@/lib/utils";

/**
 * One buyer, several orders (incident 16 Oct 2026). Staff-only pieces that
 * show the buyer's other orders wherever a person works an order: the card on
 * the order page and the compact strip on QC and Approve. Plain presentational
 * components with no hooks, so server pages and client screens both use them.
 */

function Thumb({ src, number, className }: { src: string | null; number: string; className: string }) {
  return src ? (
    <img
      src={src}
      alt={`Newest artwork for ${number}`}
      loading="lazy"
      decoding="async"
      className={cn("shrink-0 rounded-input bg-canvas object-cover", className)}
    />
  ) : (
    <span role="img" aria-label={`No artwork for ${number} yet`} className={cn("shrink-0 rounded-input bg-canvas", className)} />
  );
}

function stageVariant(o: SameBuyerCardOrder): "neutral" | "info" | "success" {
  if (o.cancelled || o.notInAlphaOS) return "neutral";
  return o.delivered ? "success" : "info";
}

/** What the order is, then who a gift goes to; or what the notes say when AlphaOS has no such order. */
function detailLine(o: SameBuyerCardOrder): string {
  const what = o.productLine || o.noteHint || "";
  return [what, o.shipTo ? `gift to ${o.shipTo}` : ""].filter(Boolean).join(" \u00b7 ");
}

/** The "Same buyer" card on the order page. Nothing when the buyer has no other order. */
export function SameBuyerCard({ view, className }: { view: SameBuyerView | null | undefined; className?: string }) {
  if (!view || view.others.length === 0) return null;
  const { others } = view;
  return (
    <section data-testid="same-buyer-card" aria-label="Same buyer" className={cn("rounded-card bg-surface p-4 shadow-card", className)}>
      <div className="flex items-center gap-1.5 text-xs font-medium text-pigment">
        <Users size={14} />
        Same buyer
      </div>
      <p className="mt-1 text-sm text-ink">
        This buyer has {others.length} other order{others.length === 1 ? "" : "s"}. Keep their files, proofs and replies apart: check the order number first.
      </p>
      <ul className="mt-3 flex flex-col divide-y divide-line/60">
        {others.map((o) => {
          const body = (
            <>
              <Thumb src={o.thumb} number={o.number} className="size-14" />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="font-medium text-ink">{o.number}</span>
                  <Badge variant={stageVariant(o)}>{o.stage}</Badge>
                </span>
                {detailLine(o) ? <span className="break-words text-sm text-slate">{detailLine(o)}</span> : null}
                {o.notInAlphaOS ? <span className="text-xs text-slate">Named in this order&apos;s notes, not in AlphaOS.</span> : null}
              </span>
            </>
          );
          return (
            <li key={o.id ?? o.number} data-testid="same-buyer-order">
              {o.id ? (
                <Link href={`/orders/${o.id}`} className="flex min-h-11 items-center gap-3 rounded-input py-2 hover:bg-canvas">
                  {body}
                </Link>
              ) : (
                <div className="flex min-h-11 items-center gap-3 py-2">{body}</div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** How many of the buyer's other orders the compact strip lists before pointing at the order page. */
const STRIP_MAX = 4;

/**
 * Next to the file being judged on QC and Approve: a line saying which order
 * this is and who it ships to, then, when the buyer has other orders, a
 * compact strip of them with a thumbnail of each one's newest artwork. The
 * chips open in a new tab so the person keeps their place.
 */
export function SameBuyerStrip({ view, className }: { view: SameBuyerView | null | undefined; className?: string }) {
  if (!view) return null;
  const { thisOrder, others } = view;
  const shown = others.slice(0, STRIP_MAX);
  const hidden = others.length - shown.length;
  return (
    <div data-testid="same-buyer-strip" className={cn("flex flex-col gap-2", className)}>
      <p data-testid="this-order-line" className="break-words text-sm text-ink">
        <span className="font-semibold">This order:</span> {thisOrder.number}
        {thisOrder.productLine ? `, ${thisOrder.productLine}` : ""}
        {thisOrder.shipToName ? `, ships to ${thisOrder.shipToName}` : ""}
      </p>
      {others.length ? (
        <div data-testid="same-buyer-also" className="flex flex-col gap-1.5 rounded-card border border-amber/40 bg-amber/5 p-2">
          <p id="same-buyer-also-label" className="text-xs font-semibold text-amber">
            Same buyer also ordered:
          </p>
          <ul aria-labelledby="same-buyer-also-label" className="flex flex-col gap-1.5 sm:flex-row sm:flex-wrap">
            {shown.map((o) => {
              const body = (
                <>
                  <Thumb src={o.thumb} number={o.number} className="size-10" />
                  <span className="flex min-w-0 flex-col">
                    <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                      <span className="text-sm font-semibold text-ink">{o.number}</span>
                      <Badge variant={stageVariant(o)}>{o.stage}</Badge>
                    </span>
                    {detailLine(o) ? <span className="truncate text-xs text-slate">{detailLine(o)}</span> : null}
                  </span>
                </>
              );
              const chip = "flex min-h-11 min-w-0 items-center gap-2 rounded-input border border-line bg-surface p-1.5 pr-3 sm:max-w-xs";
              return (
                <li key={o.id ?? o.number} data-testid="same-buyer-order" className="min-w-0">
                  {o.id ? (
                    <Link href={`/orders/${o.id}`} target="_blank" rel="noreferrer" className={cn(chip, "hover:bg-canvas")}>
                      {body}
                    </Link>
                  ) : (
                    <div className={cn(chip, "border-dashed")}>{body}</div>
                  )}
                </li>
              );
            })}
          </ul>
          {hidden > 0 ? (
            <Link href={`/orders/${thisOrder.id}`} target="_blank" rel="noreferrer" className="text-xs font-medium text-pigment hover:underline">
              and {hidden} more on the order page
            </Link>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
