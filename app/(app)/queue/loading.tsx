import { Page, Skeleton } from "@/components/ui";

/**
 * Queue skeleton — shown instantly on navigation and on every tab switch while
 * the cards load, so the queue and its tabs feel immediate.
 */
export default function QueueLoading() {
  return (
    <Page className="max-w-none">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <Skeleton className="h-7 w-28" />
          <Skeleton className="h-4 w-80" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-10 w-20 rounded-input" />
          <Skeleton className="h-10 w-28 rounded-input" />
          <Skeleton className="h-10 w-28 rounded-input" />
        </div>
      </div>

      <div className="flex flex-wrap gap-1">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-28 rounded-input" />
        ))}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="space-y-3 rounded-card border border-line bg-surface p-4 shadow-sm">
            <div className="flex items-center justify-between">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-16" />
            </div>
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-3 w-2/3" />
            <div className="flex gap-2 pt-1">
              <Skeleton className="h-8 w-24 rounded-input" />
              <Skeleton className="h-8 w-20 rounded-input" />
            </div>
          </div>
        ))}
      </div>
    </Page>
  );
}
