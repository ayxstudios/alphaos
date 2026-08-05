"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

import { cn } from "@/lib/utils";
import { Avatar } from "@/components/ui";
import { focusRing } from "@/components/ui/styles";
import { ChevronDown, Search } from "@/components/ui/icons";
import type { RailDesigner } from "@/lib/designers/roster";

const COLLAPSE_KEY = "board.rail.collapsed";

/**
 * App-wide right sidebar for switching designer boards. Shown on every page for
 * staff — click a designer to jump to their board (Links prefetch, so it's
 * instant). Filter by name when the roster is long; collapse to a thin avatar
 * strip. The active highlight tracks the ?designer param on the board page.
 */
export function DesignerRail({ designers }: { designers: RailDesigner[] }) {
  const pathname = usePathname();
  const params = useSearchParams();
  const current = pathname === "/board" ? params.get("designer") ?? undefined : undefined;

  const [collapsed, setCollapsed] = useState(false);
  const [q, setQ] = useState("");

  useEffect(() => {
    setCollapsed(localStorage.getItem(COLLAPSE_KEY) === "1");
  }, []);
  function toggle() {
    setCollapsed((c) => {
      const next = !c;
      localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
      return next;
    });
  }

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    return term ? designers.filter((d) => d.name.toLowerCase().includes(term)) : designers;
  }, [designers, q]);

  if (collapsed) {
    return (
      <aside className="flex h-screen w-14 shrink-0 flex-col items-center gap-1 overflow-y-auto border-l border-line bg-surface p-2">
        <button
          type="button"
          onClick={toggle}
          aria-label="Expand designer rail"
          className={cn(
            "mb-1 flex size-9 items-center justify-center rounded-input text-slate hover:bg-canvas hover:text-ink",
            focusRing,
          )}
        >
          <ChevronDown size={16} className="rotate-90" />
        </button>
        {designers.map((d) => (
          <Link
            key={d.id}
            href={`/board?designer=${d.id}`}
            title={d.name}
            aria-current={d.id === current ? "page" : undefined}
            className={cn(
              "rounded-full ring-2 ring-transparent transition",
              d.id === current && "ring-pigment",
              focusRing,
            )}
          >
            <Avatar name={d.name} size="sm" />
          </Link>
        ))}
      </aside>
    );
  }

  return (
    <aside className="flex h-screen w-60 shrink-0 flex-col border-l border-line bg-surface">
      <div className="flex items-center justify-between border-b border-line px-3 py-3">
        <span className="text-sm font-semibold text-ink">Designers</span>
        <button
          type="button"
          onClick={toggle}
          aria-label="Collapse designer rail"
          className={cn(
            "flex size-7 items-center justify-center rounded-input text-slate hover:bg-canvas hover:text-ink",
            focusRing,
          )}
        >
          <ChevronDown size={16} className="-rotate-90" />
        </button>
      </div>

      <div className="border-b border-line p-2">
        <div className="relative">
          <Search size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Find designer…"
            className={cn(
              "h-9 w-full rounded-input border border-line bg-surface pl-8 pr-2.5 text-sm text-ink placeholder:text-slate",
              focusRing,
            )}
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-1.5">
        {filtered.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-slate">
            {designers.length === 0 ? "No designers" : "No match"}
          </p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {filtered.map((d) => {
              const active = d.id === current;
              const atLimit = d.dailyCapacity > 0 && d.assignedToday >= d.dailyCapacity;
              return (
                <li key={d.id}>
                  <Link
                    href={`/board?designer=${d.id}`}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex items-center gap-2.5 rounded-input px-2 py-1.5 text-sm transition-colors motion-hover",
                      active ? "bg-pigment-soft text-pigment" : "text-ink hover:bg-canvas",
                      focusRing,
                    )}
                  >
                    <Avatar name={d.name} size="sm" />
                    <span className="min-w-0 flex-1 truncate font-medium">{d.name}</span>
                    <span
                      className={cn(
                        "shrink-0 rounded-full px-1.5 py-0.5 text-[11px] font-medium tabular-nums",
                        atLimit ? "bg-rose/10 text-rose" : "bg-canvas text-slate",
                      )}
                    >
                      {d.assignedToday}/{d.dailyCapacity}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}
