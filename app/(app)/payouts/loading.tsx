import { Page, Skeleton } from "@/components/ui";
import { HeaderSkeleton, RowsSkeleton } from "@/components/shell/skeletons";

/** Payouts: header with Export CSV, the business + period filters, then the tables. */
export default function PayoutsLoading() {
  return (
    <Page>
      <HeaderSkeleton actions={1} />
      <div className="flex flex-wrap gap-2">
        <Skeleton className="h-11 w-44 rounded-full" />
        <Skeleton className="h-11 w-44 rounded-full" />
        <Skeleton className="h-11 w-20 rounded-full" />
      </div>
      <RowsSkeleton rows={6} head />
      <RowsSkeleton rows={3} />
    </Page>
  );
}
