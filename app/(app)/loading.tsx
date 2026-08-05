import { Page, Skeleton } from "@/components/ui";

/**
 * Generic page skeleton — the Suspense fallback for any (app) route without its
 * own loading.tsx (dashboard, orders, customers, settings…). Gives every
 * navigation instant feedback while the server component streams in.
 */
export default function AppLoading() {
  return (
    <Page>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-4 w-72" />
        </div>
        <Skeleton className="h-10 w-32 rounded-input" />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-24 rounded-card" />
        ))}
      </div>

      <div className="space-y-2 rounded-card border border-line bg-surface p-4 shadow-sm">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    </Page>
  );
}
