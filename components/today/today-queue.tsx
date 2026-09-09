"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { cn } from "@/lib/utils";
import type { TodayBand, TodayItem, TodayKind } from "@/lib/orders/today-queue";
import { focusRing } from "@/components/ui/styles";
import { ArrowRight, CheckCircle, ChevronDown } from "@/components/ui/icons";
import { ShopBadge } from "@/components/ui/shop-badge";

const BAND_META: Record<TodayBand, { title: string; hint: string }> = {
  now: { title: "Now", hint: "someone is waiting on you" },
  today: { title: "Today", hint: "ready for you to do" },
  soon: { title: "Soon", hint: "nudges and tidy-ups" },
};

const BANDS: TodayBand[] = ["now", "today", "soon"];

/** Short kind names for the summary chips, in a fixed order. */
const KIND_CHIP: { kind: TodayKind; label: string }[] = [
  { kind: "reply", label: "Replies" },
  { kind: "details", label: "Details" },
  { kind: "designer_late", label: "Late designs" },
  { kind: "unassigned", label: "Unassigned" },
  { kind: "qc", label: "QC" },
  { kind: "tracking", label: "Tracking" },
  { kind: "print", label: "Print" },
  { kind: "proof_silent", label: "Quiet proofs" },
  { kind: "photos_silent", label: "No photos" },
  { kind: "triage", label: "Triage" },
];

/** Rows shown per section before "Show more" (then this many more per click). */
const PAGE = 8;

/**
 * The Today queue: the same ranked list, but the page opens calm. A strip of
 * kind chips says what the queue is made of (and filters it), each section
 * shows its first eight rows, and every row is one line with one button.
 * Nothing is removed: "Show more" pages through the rest, j/k/Enter still work.
 */
export function TodayQueueList({ groups }: { groups: Record<TodayBand, TodayItem[]> }) {
  const router = useRouter();
  const all = useMemo(() => BANDS.flatMap((b) => groups[b]), [groups]);
  const [kind, setKind] = useState<TodayKind | null>(null);
  const [shown, setShown] = useState<Record<TodayBand, number>>({ now: PAGE, today: PAGE, soon: PAGE });
  const [open, setOpen] = useState<Record<TodayBand, boolean>>({
    now: true,
    today: true,
    soon: groups.now.length + groups.today.length === 0,
  });
  const [cursor, setCursor] = useState(0);
  const rowRefs = useRef(new Map<string, HTMLLIElement>());

  const counts = useMemo(() => {
    const m = new Map<TodayKind, number>();
    for (const it of all) m.set(it.kind, (m.get(it.kind) ?? 0) + 1);
    return m;
  }, [all]);
  const chips = KIND_CHIP.filter((c) => (counts.get(c.kind) ?? 0) > 0);

  // What each section shows right now (filtered, then paged).
  const visible = useMemo(() => {
    const out = {} as Record<TodayBand, { items: TodayItem[]; total: number }>;
    for (const b of BANDS) {
      const items = kind ? groups[b].filter((it) => it.kind === kind) : groups[b];
      out[b] = { items: open[b] ? items.slice(0, shown[b]) : [], total: items.length };
    }
    return out;
  }, [groups, kind, shown, open]);
  const flat = useMemo(() => BANDS.flatMap((b) => visible[b].items), [visible]);
  const active = flat[Math.min(cursor, Math.max(0, flat.length - 1))];

  useEffect(() => {
    setCursor(0);
    setShown({ now: PAGE, today: PAGE, soon: PAGE });
  }, [kind]);

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
      } else if (e.key === "Enter" && active) {
        e.preventDefault();
        router.push(active.action.href);
      }
    },
    [flat.length, active, router],
  );

  useEffect(() => {
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onKey]);

  if (all.length === 0) {
    return (
      <div className="flex flex-col items-center gap-4 rounded-card bg-surface px-6 py-16 text-center shadow-card">
        <span className="flex size-16 items-center justify-center rounded-full bg-sage/10 text-sage">
          <CheckCircle size={32} />
        </span>
        <div>
          <p className="font-display text-2xl font-semibold text-ink">All caught up.</p>
          <p className="mt-1 text-base text-slate">Nothing waiting on you.</p>
        </div>
        <Link href="/orders" className={cn("mt-2 inline-flex h-11 items-center gap-2 rounded-input bg-canvas px-4 text-base font-medium text-ink hover:bg-pigment-soft/60", focusRing)}>
          Look at all orders
          <ArrowRight size={16} />
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* What the queue is made of. Tap a chip to see only that kind. */}
      {chips.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter by kind">
          <Chip active={kind === null} onClick={() => setKind(null)}>
            All <span className="tabular-nums opacity-70">{all.length}</span>
          </Chip>
          {chips.map((c) => (
            <Chip key={c.kind} active={kind === c.kind} onClick={() => setKind(kind === c.kind ? null : c.kind)}>
              {c.label} <span className="tabular-nums opacity-70">{counts.get(c.kind)}</span>
            </Chip>
          ))}
        </div>
      )}

      {BANDS.map((band) => {
        const { items, total } = visible[band];
        const meta = BAND_META[band];
        const done = total === 0;
        const isOpen = open[band] && !done;
        const hidden = total - items.length;
        return (
          <section key={band} className="rounded-card bg-surface shadow-card">
            <button
              type="button"
              onClick={() => setOpen((o) => ({ ...o, [band]: !o[band] }))}
              disabled={done}
              aria-expanded={isOpen}
              className={cn(
                "flex min-h-12 w-full items-center justify-between gap-3 rounded-card px-4 py-3 text-left",
                !done && "hover:bg-canvas/70",
                focusRing,
              )}
            >
              <span className="flex min-w-0 items-baseline gap-2">
                <span className="font-display text-base font-semibold text-ink">{meta.title}</span>
                <span className="truncate text-sm text-slate">
                  {done ? "nothing here" : `${total} ${meta.hint}`}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-2">
                {done ? (
                  <span className="text-xs font-medium text-sage">Done</span>
                ) : (
                  <ChevronDown size={18} className={cn("text-slate transition-transform", isOpen && "rotate-180")} />
                )}
              </span>
            </button>
            {isOpen && (
              <>
                <ul className="divide-y divide-line/70 border-t border-line/70">
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
                        className={cn("relative flex items-center gap-3 px-4 py-2.5", selected && "bg-pigment-soft/40")}
                      >
                        {selected && <span aria-hidden className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-pigment" />}
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 items-center gap-2">
                            <ShopBadge platform={item.platform} name={item.shop} className="shrink-0 text-xs" />
                            <Link href={`/orders/${item.orderId}`} className={cn("shrink-0 text-xs font-semibold text-ink hover:text-pigment", focusRing)}>
                              {item.orderNumber}
                            </Link>
                            <span className="hidden min-w-0 truncate text-sm text-ink md:inline">{item.todo}</span>
                          </div>
                          <p className="mt-0.5 flex min-w-0 items-center gap-2 md:hidden">
                            <span className="min-w-0 truncate text-sm text-ink">{item.todo}</span>
                            <span className="ml-auto shrink-0 whitespace-nowrap text-xs tabular-nums text-slate">{item.age}</span>
                          </p>
                        </div>
                        <span className="hidden shrink-0 whitespace-nowrap text-xs tabular-nums text-slate sm:inline">{item.age}</span>
                        <Link
                          href={item.action.href}
                          className={cn(
                            "inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-input px-3 text-sm font-medium",
                            band === "now" ? "bg-pigment text-surface hover:opacity-90" : "bg-canvas text-ink hover:bg-pigment-soft",
                            focusRing,
                          )}
                        >
                          {item.action.label}
                          <ArrowRight size={14} className="hidden sm:block" />
                        </Link>
                      </li>
                    );
                  })}
                </ul>
                {hidden > 0 && (
                  <button
                    type="button"
                    onClick={() => setShown((s) => ({ ...s, [band]: s[band] + PAGE * 2 }))}
                    className={cn("flex h-11 w-full items-center justify-center gap-1 rounded-b-card border-t border-line/70 text-sm font-medium text-pigment hover:bg-pigment-soft/50", focusRing)}
                  >
                    Show {Math.min(hidden, PAGE * 2)} more
                    <span className="text-slate">of {hidden}</span>
                  </button>
                )}
              </>
            )}
          </section>
        );
      })}
      <p className="hidden text-xs text-slate/80 lg:block">
        <kbd className="rounded-chip bg-surface px-1.5 shadow-card">j</kbd> / <kbd className="rounded-chip bg-surface px-1.5 shadow-card">k</kbd> to move, <kbd className="rounded-chip bg-surface px-1.5 shadow-card">Enter</kbd> to open.
      </p>
    </div>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex h-8 items-center gap-1 rounded-full px-3 text-sm font-medium transition-colors motion-hover",
        active ? "bg-ink text-surface" : "bg-surface text-ink shadow-card hover:bg-canvas",
        focusRing,
      )}
    >
      {children}
    </button>
  );
}
