import { Page, Skeleton } from "@/components/ui";
import { HeaderSkeleton, RowsSkeleton } from "@/components/shell/skeletons";

/** Customers: header, search, then the customer table. */
export default function CustomersLoading() {
  return (
    <Page>
      <HeaderSkeleton />
      <Skeleton className="h-11 w-full max-w-md rounded-full" />
      <RowsSkeleton rows={10} head />
    </Page>
  );
}
