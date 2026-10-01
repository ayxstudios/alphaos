import Link from "next/link";

import { ArrowRight } from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import { focusRing } from "@/components/ui/styles";
import type { StaffHome } from "@/lib/home/staff";
import type { TodayKind } from "@/lib/orders/today-queue";
import { fmtInt } from "@/components/charts";

type Tile = { label: string; kind: TodayKind; href: string; hint: string };

// Exactly three things a VA acts on. Counts come from the Today queue kinds:
// "qc" (finished portrait waiting for a check), "reply" (a customer wrote and
// nobody answered) and "print" (approved physical order not yet sent to print,
// which is the one a person has to press OK on).
const TILES: Tile[] = [
  { label: "Awaiting QC", kind: "qc", href: "/qc", hint: "Portraits to check against the customer photos" },
  { label: "Need a VA reply", kind: "reply", href: "/emails", hint: "Only the complex messages, Alpha answers the rest" },
  { label: "Awaiting print approval", kind: "print", href: "/queue/print", hint: "Print jobs waiting for your OK" },
];

/** VA home: three large tiles and nothing else. */
export function VaHome({ h }: { h: StaffHome }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:gap-5 lg:grid-cols-3">
      {TILES.map((t) => {
        const n = h.attention.byKind.find((k) => k.kind === t.kind)?.n ?? 0;
        return (
          <Link
            key={t.kind}
            href={t.href}
            className={cn(
              "group flex min-h-44 min-w-0 flex-col justify-between gap-6 rounded-card bg-surface p-6 shadow-card transition-[transform,box-shadow] duration-150 hover:-translate-y-0.5 hover:shadow-md",
              focusRing,
            )}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2 text-sm font-medium text-slate">
                <span className={cn("size-2 rounded-full", n === 0 ? "bg-sage" : "bg-amber")} />
                {t.label}
              </span>
              <ArrowRight size={16} className="shrink-0 text-slate opacity-60 transition-opacity group-hover:opacity-100" />
            </div>
            <div>
              <div className="font-display text-5xl font-semibold tabular-nums leading-none text-ink sm:text-6xl">{fmtInt(n)}</div>
              <p className="mt-3 text-base text-ink">{t.hint}</p>
            </div>
          </Link>
        );
      })}
    </div>
  );
}
