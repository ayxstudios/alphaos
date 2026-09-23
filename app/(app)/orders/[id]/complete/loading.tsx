import { DataPanel, Page, Skeleton } from "@/components/ui";
import { HeaderSkeleton } from "@/components/shell/skeletons";

/**
 * Complete order details: the header, then one form card (the shop summary,
 * then the numbered steps), so the page does not jump when the form arrives.
 */
export default function CompleteDetailsLoading() {
  return (
    <Page className="max-w-5xl">
      <HeaderSkeleton eyebrow actions={1} />
      <DataPanel className="flex flex-col gap-6 p-5">
        <Skeleton className="h-40 rounded-card" />
        <Skeleton className="h-14 rounded-card" />
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="flex flex-col gap-3">
            <Skeleton className="h-5 w-32" />
            <div className="grid gap-3 sm:grid-cols-2">
              <Skeleton className="h-10" />
              <Skeleton className="h-10" />
            </div>
          </div>
        ))}
      </DataPanel>
    </Page>
  );
}
