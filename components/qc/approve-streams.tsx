import Link from "next/link";

import { STREAMS, type Stream } from "@/lib/qc/approve-streams";
import { cn } from "@/lib/utils";
import { focusRing } from "@/components/ui/styles";

/**
 * New orders | Revisions | Cases (both owners, 2026-10-21). Each tab shows how many are waiting; a Cases count in rose means
 * one of them is urgent. Cases is null when the agent's case list could not be read, or hidden when the viewer is not an owner.
 */
export function StreamTabs({
  active,
  counts,
  casesUrgent = false,
}: {
  active: Stream;
  counts: { new: number; revision: number; cases?: number | null };
  casesUrgent?: boolean;
}) {
  const tabs = STREAMS.filter((s) => s.key !== "cases" || counts.cases !== undefined); // no Cases tab for a non-owner
  return (
    <nav aria-label="What to check" className="mx-auto flex w-full max-w-5xl gap-1 rounded-card bg-surface p-1 shadow-card" data-testid="stream-tabs">
      {tabs.map((t) => {
        const n = t.key === "cases" ? (counts.cases ?? null) : counts[t.key];
        const on = active === t.key;
        return (
          <Link
            key={t.key}
            href={`/approve?s=${t.key}`}
            aria-current={on ? "page" : undefined}
            data-testid={`stream-${t.key}`}
            className={cn(
              "flex min-h-11 min-w-0 flex-1 items-center justify-center gap-2 rounded-input px-2 text-sm font-semibold sm:text-base",
              focusRing,
              on ? "bg-pigment-soft text-pigment" : "text-slate hover:text-ink",
            )}
          >
            <span className="truncate sm:hidden">{t.short}</span>
            <span className="hidden truncate sm:inline">{t.label}</span>
            <span
              className={cn(
                "inline-flex min-w-6 items-center justify-center rounded-full px-1.5 text-xs font-bold tabular-nums",
                n === 0 ? "bg-canvas text-slate" : t.key === "cases" && casesUrgent ? "bg-rose text-surface" : on ? "bg-pigment text-surface" : "bg-ink/10 text-ink",
              )}
            >
              {n === null ? "?" : n}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}
