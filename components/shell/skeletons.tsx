import { cn } from "@/lib/utils";
import { DataPanel, Skeleton } from "@/components/ui";

/**
 * Loading skeletons for the route-level loading.tsx files (docs/PERF.md).
 * Each page's skeleton reuses these blocks in that page's own layout, so a
 * navigation paints the right shape at once and the real content replaces it
 * without a jump. Server components, no client JS.
 */

export function HeaderSkeleton({
  eyebrow = false,
  description = true,
  actions = 0,
}: {
  eyebrow?: boolean;
  description?: boolean;
  /** How many action buttons sit on the right of the header. */
  actions?: number;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0 space-y-2">
        {eyebrow && <Skeleton className="h-3 w-24" />}
        <Skeleton className="h-7 w-44" />
        {description && <Skeleton className="h-4 w-72 max-w-full" />}
      </div>
      {actions > 0 && (
        <div className="flex gap-2">
          {Array.from({ length: actions }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-28 rounded-input" />
          ))}
        </div>
      )}
    </div>
  );
}

/** A panel of list rows (tables, queues, lists). */
export function RowsSkeleton({
  rows = 6,
  head = false,
  className,
  rowClassName = "h-5",
}: {
  rows?: number;
  /** A column-header strip above the rows (desktop tables). */
  head?: boolean;
  className?: string;
  rowClassName?: string;
}) {
  return (
    <DataPanel className={cn("overflow-hidden", className)}>
      {head && (
        <div className="hidden border-b border-line/60 px-4 py-3 md:block">
          <Skeleton className="h-3 w-1/2" />
        </div>
      )}
      <div className="divide-y divide-line/60">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 px-4 py-3.5">
            <Skeleton className={cn("w-1/3", rowClassName)} />
            <Skeleton className={cn("hidden w-1/4 sm:block", rowClassName)} />
            <Skeleton className={cn("ml-auto w-16", rowClassName)} />
          </div>
        ))}
      </div>
    </DataPanel>
  );
}

/** A row of number tiles (dashboards, summaries). */
export function TilesSkeleton({ count = 4, className }: { count?: number; className?: string }) {
  return (
    <div className={cn("grid grid-cols-2 gap-3 lg:grid-cols-4", className)}>
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton key={i} className="h-24 rounded-card" />
      ))}
    </div>
  );
}

/** A titled panel with a few text lines (settings sections, side cards). */
export function PanelSkeleton({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <DataPanel className={cn("space-y-3 p-4", className)}>
      <Skeleton className="h-4 w-32" />
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} className={cn("h-4", i === lines - 1 ? "w-2/3" : "w-full")} />
      ))}
    </DataPanel>
  );
}

/** Card-shaped blocks stacked (queue items, print jobs). */
export function CardsSkeleton({ count = 3, className = "h-16" }: { count?: number; className?: string }) {
  return (
    <div className="flex flex-col gap-3">
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton key={i} className={cn("rounded-card", className)} />
      ))}
    </div>
  );
}
