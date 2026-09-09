import Link from "next/link";

import { cn } from "@/lib/utils";
import { focusRing } from "@/components/ui/styles";
import { ShopBadge } from "@/components/ui/shop-badge";
import { ArrowRight, CheckCircle } from "@/components/ui/icons";
import type { TodayItem, TodayKind } from "@/lib/orders/today-queue";

const KIND_TONE: Record<TodayKind, string> = {
  reply: "bg-amber/10 text-amber",
  details: "bg-amber/10 text-amber",
  proof_silent: "bg-amber/10 text-amber",
  photos_silent: "bg-amber/10 text-amber",
  qc: "bg-pigment-soft text-pigment",
  unassigned: "bg-pigment-soft text-pigment",
  designer_late: "bg-rose/10 text-rose",
  tracking: "bg-slate/10 text-slate",
  print: "bg-slate/10 text-slate",
  triage: "bg-rose/10 text-rose",
};

const KIND_SHORT: Record<TodayKind, string> = {
  reply: "Reply",
  details: "Details",
  proof_silent: "Quiet proof",
  photos_silent: "No photos",
  qc: "QC",
  unassigned: "Assign",
  designer_late: "Late",
  tracking: "Tracking",
  print: "Print",
  triage: "Triage",
};

/**
 * The five things to do first, then one link to the full queue. Colour codes
 * the kind (amber = waiting on a person, violet = design, rose = late) and the
 * chip text says it too.
 */
export function AttentionList({ items, total, allHref = "/today" }: { items: TodayItem[]; total: number; allHref?: string }) {
  if (items.length === 0) {
    return (
      <div className="flex items-center gap-3 rounded-input bg-sage/10 px-4 py-3 text-sm text-sage">
        <CheckCircle size={18} />
        Nothing is waiting on you right now.
      </div>
    );
  }
  return (
    <div className="flex flex-col">
      <ul className="divide-y divide-line">
        {items.map((it) => (
          <li key={it.id} className="flex items-center gap-3 py-2.5">
            <span className={cn("hidden w-20 shrink-0 rounded-chip px-2 py-0.5 text-center text-xs font-medium sm:block", KIND_TONE[it.kind])}>{KIND_SHORT[it.kind]}</span>
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2 text-xs text-slate">
                <ShopBadge platform={it.platform} name={it.shop} className="min-w-0 text-xs" />
                <span className="shrink-0 font-semibold text-ink">{it.orderNumber}</span>
                <span className="ml-auto shrink-0 whitespace-nowrap tabular-nums">{it.age}</span>
              </div>
              <p className="truncate text-sm text-ink">{it.todo}</p>
            </div>
            <Link
              href={it.action.href}
              className={cn("hidden h-8 shrink-0 items-center rounded-input border border-line bg-surface px-3 text-xs font-medium text-ink hover:bg-canvas sm:inline-flex", focusRing)}
            >
              {it.action.label}
            </Link>
          </li>
        ))}
      </ul>
      {total > items.length && (
        <Link
          href={allHref}
          className={cn("mt-2 inline-flex h-10 items-center justify-center gap-2 rounded-input bg-pigment-soft px-4 text-sm font-medium text-pigment hover:bg-pigment/15", focusRing)}
        >
          See all {total} in the queue
          <ArrowRight size={15} />
        </Link>
      )}
    </div>
  );
}
