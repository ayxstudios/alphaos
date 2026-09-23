import { Page, Skeleton } from "@/components/ui";
import { HeaderSkeleton, RowsSkeleton } from "@/components/shell/skeletons";

/** Orders: header with New order, the row of view pills, then the table. */
export default function OrdersLoading() {
  return (
    <Page className="max-w-none">
      <HeaderSkeleton description={false} actions={1} />
      <div className="flex gap-1.5 overflow-hidden">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-28 shrink-0 rounded-full" />
        ))}
      </div>
      <Skeleton className="h-11 w-full max-w-md rounded-full" />
      <RowsSkeleton rows={10} head />
    </Page>
  );
}
