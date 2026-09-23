import { Page, Skeleton } from "@/components/ui";
import { CardsSkeleton, HeaderSkeleton } from "@/components/shell/skeletons";

/** Today: header, the one-line summary, then the ranked queue. */
export default function TodayLoading() {
  return (
    <Page className="max-w-4xl">
      <HeaderSkeleton eyebrow description={false} />
      <Skeleton className="-mt-3 h-5 w-64" />
      <CardsSkeleton count={5} />
    </Page>
  );
}
