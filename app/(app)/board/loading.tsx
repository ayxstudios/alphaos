import { Page, Skeleton } from "@/components/ui";

/**
 * Board skeleton — shown instantly on navigation (and cached by Link prefetch)
 * while the columns load, so switching to the board never feels frozen.
 */
export default function BoardLoading() {
  return (
    <Page className="max-w-none">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <Skeleton className="h-7 w-40" />
          <Skeleton className="h-4 w-72" />
        </div>
        <Skeleton className="h-14 w-36 rounded-card" />
      </div>

      <div className="flex gap-3 overflow-hidden pb-4">
        {Array.from({ length: 5 }).map((_, col) => (
          <div key={col} className="flex w-[20rem] shrink-0 flex-col gap-2 rounded-card bg-canvas p-2">
            <div className="flex items-center justify-between px-1 py-1">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-5 w-6 rounded-full" />
            </div>
            {Array.from({ length: col === 0 ? 3 : 2 }).map((_, i) => (
              <div key={i} className="overflow-hidden rounded-card border border-line bg-surface">
                <Skeleton className="h-32 w-full rounded-none" />
                <div className="space-y-2 p-3">
                  <Skeleton className="h-4 w-20" />
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-3 w-2/3" />
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </Page>
  );
}
