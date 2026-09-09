"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { cn } from "@/lib/utils";
import type { TodayBand, TodayItem } from "@/lib/orders/today-queue";
import { focusRing } from "@/components/ui/styles";
import { ArrowRight, CheckCircle, ChevronDown } from "@/components/ui/icons";
import { ShopBadge } from "@/components/ui/shop-badge";

const BAND_META: Record<TodayBand, { title: string; hint: string }> = {
  now: { title: "Now", hint: "Someone is waiting on you" },
  today: { title: "Today", hint: "Ready for you to do" },
  soon: { title: "Soon", hint: "Nudges and tidy-ups" },
};

const BANDS: TodayBand[] = ["now", "today", "soon"];

export function TodayQueueList({ groups }: { groups: Record<TodayBand, TodayItem[]> }) {
  const router = useRouter();
  const flat = useMemo(() => BANDS.flatMap((b) => groups[b]), [groups]);
  const [cursor, setCursor] = useState(0);
  const [open, setOpen] = useState<Record<TodayBand, boolean>>({
    now: true,
    today: true,
    soon: groups.now.length + groups.today.length === 0,
  });
  const rowRefs = useRef(new Map<string, HTMLLIElement>());

  const active = flat[cursor];

  useEffect(() => {
    if (!active) return;
    rowRefs.current.get(active.id)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const onKey = useCallback(
    (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (e.target as HTMLElement | null)?.isContentEditable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        setCursor((c) => Math.min(flat.length - 1, c + 1));
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        setCursor((c) => Math.max(0, c - 1));
      } else if (e.key === "Enter" && flat[cursor]) {
        e.preventDefault();
        router.push(flat[cursor].action.href);
      }
    },
    [flat, cursor, router],
  );

  useEffect(() => {
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onKey]);

  if (flat.length === 0) {
    return (
      <div className="flex flex-col items-center gap-4 rounded-card border border-line bg-surface px-6 py-16 text-center shadow-sm">
        <span className="flex size-16 items-center justify-center rounded-full bg-sage/10 text-sage">
          <CheckCircle size={32} />
        </span>
        <div>
          <p className="font-display text-2xl font-semibold text-ink">All caught up.</p>
          <p className="mt-1 text-base text-slate">Nothing waiting on you.</p>
        </div>
        <Link href="/orders" className={cn("mt-2 inline-flex h-11 items-center gap-2 rounded-input border border-line bg-surface px-4 text-base font-medium text-ink hover:bg-canvas", focusRing)}>
          Look at all orders
          <ArrowRight size={16} />
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {BANDS.map((band) => {
        const items = groups[band];
        const meta = BAND_META[band];
        const done = items.length === 0;
        const isOpen = open[band] && !done;
        return (
          <section key={band} className="rounded-card border border-line bg-surface shadow-sm">
            <button
              type="button"
              onClick={() => setOpen((o) => ({ ...o, [band]: !o[band] }))}
              disabled={done}
              aria-expanded={isOpen}
              className={cn(
                "flex min-h-12 w-full items-center justify-between gap-3 rounded-card px-4 py-3 text-left",
                !done && "hover:bg-canvas",
                focusRing,
              )}
            >
              <span className="flex min-w-0 items-baseline gap-2">
                <span className="font-display text-lg font-semibold text-ink">{meta.title}</span>
                <span className="truncate text-sm text-slate">{done ? "Nothing here" : meta.hint}</span>
              </span>
              <span className="flex shrink-0 items-center gap-2">
                <span className={cn("rounded-chip px-2 py-0.5 text-sm font-semibold", done ? "bg-sage/10 text-sage" : band === "now" ? "bg-rose/10 text-rose" : "bg-pigment-soft text-pigment")}>
                  {done ? "Done" : items.length}
                </span>
                {!done && <ChevronDown size={18} className={cn("text-slate transition-transform", isOpen && "rotate-180")} />}
              </span>
            </button>
            {isOpen && (
              <ul className="divide-y divide-line border-t border-line">
                {items.map((item) => {
                  const idx = flat.indexOf(item);
                  const selected = idx === cursor;
                  return (
                    <li
                      key={item.id}
                      ref={(el) => {
                        if (el) rowRefs.current.set(item.id, el);
                        else rowRefs.current.delete(item.id);
                      }}
                      onMouseEnter={() => setCursor(idx)}
                      className={cn("relative flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:gap-4", selected && "bg-pigment-soft/50")}
                    >
                      {selected && <span aria-hidden className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-pigment" />}
                      <div className="min-w-0 flex-1">
                        {/* Line 1: shop + order left, age right — nowrap so this
                            never wraps mid-line on a phone (the age is the one
                            piece that must stay readable at a glance). Line 2:
                            the todo sentence, which already names the customer
                            where relevant, so it isn't repeated here. */}
                        <div className="flex items-center justify-between gap-2 text-sm text-slate">
                          <span className="flex min-w-0 items-center gap-2 overflow-hidden">
                            <ShopBadge platform={item.platform} name={item.shop} />
                            <Link
                              href={`/orders/${item.orderId}`}
                              className={cn("truncate font-semibold text-ink hover:text-pigment", focusRing)}
                            >
                              {item.orderNumber}
                            </Link>
                          </span>
                          <span className="shrink-0 whitespace-nowrap tabular-nums">{item.age}</span>
                        </div>
                        <p className="mt-1 text-base text-ink">{item.todo}</p>
                      </div>
                      <Link
                        href={item.action.href}
                        className={cn(
                          "inline-flex h-11 w-full shrink-0 items-center justify-center gap-2 rounded-input px-4 text-base font-medium sm:h-10 sm:w-auto sm:text-sm",
                          band === "now" ? "bg-pigment text-surface hover:opacity-90" : "border border-line bg-surface text-ink hover:bg-canvas",
                          focusRing,
                        )}
                      >
                        {item.action.label}
                        <ArrowRight size={15} />
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}
      <p className="hidden text-sm text-slate lg:block">
        Keyboard: <kbd className="rounded-chip border border-line bg-surface px-1.5">j</kbd> / <kbd className="rounded-chip border border-line bg-surface px-1.5">k</kbd> to move, <kbd className="rounded-chip border border-line bg-surface px-1.5">Enter</kbd> to open.
      </p>
    </div>
  );
}
